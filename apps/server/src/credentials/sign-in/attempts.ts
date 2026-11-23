import { randomUUID } from "node:crypto";
import {
  type AttemptView,
  type CredentialSummary,
  MSG,
  nameSchema,
  normalizeSignInCode,
  type SignInState,
} from "@open-factory/shared";
import { ApiError, FieldError } from "../../errors.ts";
import { FIELD_MSG } from "../../field-messages.ts";
import type { CredentialService } from "../credential-service.ts";
import type { VerifyResult } from "../verify.ts";
import { type PtyRun, PtyUnavailable } from "./host-pty.ts";
import { RunFailed, type SetupTokenRun } from "./setup-token.ts";

// Spec §5.4. Nothing here logs or returns the URL (except in the owner's view), the code or the token:
// log lines are `{ userId, attemptId, reason }` with a fixed reason, and every refusal is a fixed constant.

export const SIGN_IN_TTL_MS = 10 * 60_000;
const CAP = 3;
const WAIT_MS = 50_000;
const KEEP_MS = 60_000;
const RETRY_MS = 3_000;
const TOKEN_LIFE_MS = 365 * 24 * 60 * 60_000;

export type Outcome = { status: 200 | 201; credential: CredentialSummary };

/** Live attempts hold a slot against the global cap. */
export function isLive(state: SignInState): boolean {
  return (
    state === "starting" ||
    state === "awaiting_code" ||
    state === "submitting" ||
    state === "exchanging" ||
    state === "verifying"
  );
}
/** Past the code: the code is spent and the save is seconds away, so nothing but the outcome ends it (D8). */
const pastCode = (state: SignInState) =>
  state === "submitting" || state === "exchanging" || state === "verifying";

type Purpose = { kind: "create" } | { kind: "replace"; credentialId: string; name: string };
type Result = { ok: true; outcome: Outcome } | { ok: false; error: ApiError } | { ok: "aborted" };

interface Attempt {
  attemptId: string;
  userId: string;
  state: SignInState;
  purpose: Purpose;
  name?: string;
  url?: string;
  deadline?: number;
  pty?: PtyRun;
  run?: SetupTokenRun;
  ttl?: ReturnType<typeof setTimeout>;
  drop?: ReturnType<typeof setTimeout>;
  /** Resolves when the attempt leaves `submitting` (or ends). */
  gate?: Promise<void>;
  openGate?: () => void;
  outcome?: Promise<Result>;
  ended: boolean;
  /** Rejects when the attempt ends, so a pending start step never outlives it. */
  halted: Promise<never>;
  halt: () => void;
}

interface Tombstone {
  attemptId: string;
  timer: ReturnType<typeof setTimeout>;
}

const err = {
  state: (extra: Record<string, unknown> = {}) =>
    new ApiError(409, "sign_in_state", MSG.signInState, extra),
  notFound: () => new ApiError(404, "sign_in_not_found", MSG.signInNotFound),
  replaced: () => new ApiError(409, "sign_in_replaced", MSG.signInReplaced),
  expired: () => new ApiError(410, "sign_in_expired", MSG.signInExpired),
  busy: () => new ApiError(429, "sign_in_busy", MSG.signInBusy),
  unavailable: () => new ApiError(503, "sign_in_unavailable", MSG.signInUnavailable),
  startFailed: () => new ApiError(502, "sign_in_start_failed", MSG.signInStartFailed),
  credentialDeleted: () => new ApiError(404, "credential_not_found", MSG.credentialDeleted),
  oauthOnly: () => new ApiError(400, "validation_error", MSG.signInOAuthOnly),
  codeRejected: () => new ApiError(422, "sign_in_code_rejected", MSG.signInCodeRejected),
  failed: () => new ApiError(502, "sign_in_failed", MSG.signInFailed),
  nameTaken: () => new ApiError(409, "sign_in_name_taken", MSG.signInNameTaken),
  unreachable: () => new ApiError(502, "claude_unreachable", FIELD_MSG.claudeUnreachable),
};

export class SignInAttempts {
  private readonly attempts = new Map<string, Attempt>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly waitMs: number;
  private readonly keepMs: number;
  private readonly retryMs: number;
  private readonly newId: () => string;

  constructor(
    private readonly d: {
      startPty(): Promise<PtyRun>;
      run(pty: PtyRun): SetupTokenRun;
      verify(value: string): Promise<VerifyResult>;
      credentials: Pick<
        CredentialService,
        "nameTaken" | "byName" | "insertVerified" | "replaceVerified"
      >;
      now(): number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
      ttlMs?: number;
      cap?: number;
      waitMs?: number;
      keepMs?: number;
      retryMs?: number;
      newId?(): string;
      log: { info(o: object, m: string): void };
    },
  ) {
    this.setTimer = d.setTimer ?? setTimeout;
    this.clearTimer = d.clearTimer ?? clearTimeout;
    this.ttlMs = d.ttlMs ?? SIGN_IN_TTL_MS;
    this.cap = d.cap ?? CAP;
    this.waitMs = d.waitMs ?? WAIT_MS;
    this.keepMs = d.keepMs ?? KEEP_MS;
    this.retryMs = d.retryMs ?? RETRY_MS;
    this.newId = d.newId ?? (() => randomUUID());
  }

  view(userId: string): AttemptView | null {
    const a = this.attempts.get(userId);
    return a ? this.toView(a) : null;
  }

  async start(userId: string, purpose: { replace?: string }): Promise<AttemptView> {
    // Everything up to the reservation is synchronous (§5.4 States): a second Start sees `starting`.
    const old = this.attempts.get(userId);
    if (old && (old.state === "starting" || pastCode(old.state))) throw err.state();
    let live = 0;
    for (const a of this.attempts.values()) if (a !== old && isLive(a.state)) live++;
    if (live >= this.cap) throw err.busy();
    if (old) this.end(old, old.state === "settled" ? "dropped" : "restarted");
    this.clearTombstone(userId);

    let halt!: () => void;
    const halted = new Promise<never>((_, reject) => {
      halt = () => reject(err.notFound());
    });
    halted.catch(() => {});
    const a: Attempt = {
      attemptId: this.newId(),
      userId,
      state: "starting",
      purpose: { kind: "create" },
      ended: false,
      halted,
      halt,
    };
    this.attempts.set(userId, a);
    this.log(a, "sign-in started", "started");

    if (purpose.replace !== undefined) {
      const row = await Promise.race([
        this.d.credentials.byName(purpose.replace).catch(() => undefined),
        a.halted,
      ]);
      if (row?.kind !== "oauth_token") {
        this.end(a, row ? "oauth_only" : "credential_not_found");
        throw row ? err.oauthOnly() : err.credentialDeleted();
      }
      a.purpose = { kind: "replace", credentialId: row.id, name: row.name };
      a.name = row.name;
    }

    let pty: PtyRun;
    try {
      const starting = this.d.startPty();
      // A pty that arrives after the attempt ended is killed at once.
      starting.then(
        (p) => a.ended && p.kill(),
        () => {},
      );
      pty = await Promise.race([starting, a.halted]);
    } catch (e) {
      if (a.ended) throw err.notFound();
      const unavailable = e instanceof PtyUnavailable;
      this.end(a, unavailable ? "unavailable" : "start_failed");
      throw unavailable ? err.unavailable() : err.startFailed();
    }
    a.pty = pty;
    a.run = this.d.run(pty);

    let url: string;
    try {
      ({ url } = await a.run.prompt);
    } catch (e) {
      // `aborted` is our own cancel, endFor or closeAll: the attempt is already gone; not a start failure.
      if (a.ended || (e instanceof RunFailed && e.reason === "aborted")) {
        this.end(a, "aborted");
        throw err.notFound();
      }
      this.end(a, "start_failed");
      throw err.startFailed();
    }
    if (a.ended) throw err.notFound();
    a.state = "awaiting_code";
    a.url = url;
    a.deadline = this.d.now() + this.ttlMs;
    a.ttl = this.setTimer(() => this.expire(a), this.ttlMs);
    return this.toView(a);
  }

  async submit(
    userId: string,
    attemptId: string,
    body: { code: string; name?: string },
  ): Promise<Outcome | AttemptView> {
    const a = this.lookup(userId, attemptId);
    if (a.state !== "awaiting_code") throw err.state();
    a.state = "submitting";
    a.gate = new Promise((r) => {
      a.openGate = r;
    });

    let code: string | undefined;
    let name: string | undefined;
    try {
      code = normalizeSignInCode(body.code);
      if (!code) throw new FieldError("code", MSG.signInCode);
      if (a.purpose.kind === "create") {
        const parsed = nameSchema.safeParse(body.name ?? "");
        if (!parsed.success)
          throw new FieldError("name", parsed.error.issues[0]?.message ?? MSG.nameLength);
        name = parsed.data;
        if (await this.d.credentials.nameTaken(name))
          // As CredentialService.create raises it (the name is the user's own input, not a secret).
          throw new ApiError(
            409,
            "credential_exists",
            `A credential named ${name} already exists.`,
          );
      } else {
        const { credentialId, name: credName } = a.purpose;
        const row = await this.d.credentials.byName(credName);
        if (!row || row.id !== credentialId) {
          this.end(a, "credential_not_found");
          throw err.credentialDeleted();
        }
      }
    } catch (e) {
      if (a.ended)
        throw e instanceof ApiError && e.code === "credential_not_found" ? e : err.notFound();
      // The code is not spent: back to awaiting_code with the original deadline.
      a.state = "awaiting_code";
      a.openGate?.();
      if (a.deadline !== undefined && this.d.now() >= a.deadline) this.expire(a);
      throw e;
    }
    if (a.ended) throw err.notFound();

    if (a.ttl) this.clearTimer(a.ttl);
    a.ttl = undefined;
    a.state = "exchanging";
    a.url = undefined;
    if (name !== undefined) a.name = name;
    a.openGate?.();
    a.outcome = this.exchange(a, code, name);
    return this.answer(a);
  }

  async wait(userId: string, attemptId: string): Promise<Outcome | AttemptView> {
    const a = this.lookup(userId, attemptId);
    if (a.state === "starting") throw err.state();
    if (a.state === "awaiting_code") throw err.state({ attempt: this.toView(a) });
    return this.answer(a);
  }

  async cancel(userId: string, attemptId: string): Promise<void> {
    const a = this.attempts.get(userId);
    if (!a) {
      // Already ended by its deadline: cancel is idempotent.
      if (this.tombstones.get(userId)?.attemptId === attemptId) return;
      throw err.notFound();
    }
    if (a.attemptId !== attemptId) throw err.replaced();
    if (pastCode(a.state)) throw err.state();
    this.end(a, a.state === "settled" ? "dropped" : "cancelled");
  }

  endFor(userId: string): void {
    const a = this.attempts.get(userId);
    if (!a || pastCode(a.state)) return;
    this.end(a, isLive(a.state) ? "ended" : "dropped");
  }

  async closeAll(): Promise<void> {
    const ptys: PtyRun[] = [];
    for (const a of [...this.attempts.values()]) {
      if (a.pty) ptys.push(a.pty);
      this.end(a, "closed");
    }
    for (const t of this.tombstones.values()) this.clearTimer(t.timer);
    this.tombstones.clear();
    await Promise.all(ptys.map((p) => p.exit.catch(() => undefined)));
  }

  // --- internals ---

  /** User first (none → 404, or 410 for a just-expired id), then the attemptId (different → 409). */
  private lookup(userId: string, attemptId: string): Attempt {
    const a = this.attempts.get(userId);
    if (!a) {
      if (this.tombstones.get(userId)?.attemptId === attemptId) throw err.expired();
      throw err.notFound();
    }
    if (a.attemptId !== attemptId) throw err.replaced();
    return a;
  }

  private toView(a: Attempt): AttemptView {
    const withUrl = a.state === "awaiting_code" || a.state === "submitting";
    return {
      attemptId: a.attemptId,
      state: a.state,
      ...(withUrl && a.url ? { url: a.url } : {}),
      ...(withUrl && a.deadline !== undefined
        ? { codeDeadline: new Date(a.deadline).toISOString() }
        : {}),
      purpose: a.purpose.kind,
      ...(a.name !== undefined ? { name: a.name } : {}),
    };
  }

  /** Kill, forget, and drop the attempt. The run's abort kills the PTY (which removes the dir). */
  private end(a: Attempt, reason: string) {
    if (a.ended) return;
    a.ended = true;
    if (a.ttl) this.clearTimer(a.ttl);
    if (a.drop) this.clearTimer(a.drop);
    a.run?.abort();
    a.pty?.kill();
    a.url = undefined;
    a.openGate?.();
    a.halt();
    if (this.attempts.get(a.userId) === a) this.attempts.delete(a.userId);
    if (reason !== "dropped") this.log(a, "sign-in ended", reason);
  }

  private expire(a: Attempt) {
    if (a.ended || a.state !== "awaiting_code") return; // submitting: the name check decides
    this.end(a, "expired");
    this.clearTombstone(a.userId);
    const timer = this.setTimer(() => {
      if (this.tombstones.get(a.userId)?.attemptId === a.attemptId)
        this.tombstones.delete(a.userId);
    }, this.keepMs);
    this.tombstones.set(a.userId, { attemptId: a.attemptId, timer });
  }

  private clearTombstone(userId: string) {
    const t = this.tombstones.get(userId);
    if (t) this.clearTimer(t.timer);
    this.tombstones.delete(userId);
  }

  /** The store's own promise (D7): never rejects, so a closed connection never cancels the save. */
  private async exchange(a: Attempt, code: string, name: string | undefined): Promise<Result> {
    const result = await this.mint(a, code, name).catch(
      (e): Result => (a.ended ? { ok: "aborted" } : { ok: false, error: toError(e) }),
    );
    if (a.ended) return { ok: "aborted" };
    a.state = "settled";
    a.pty = undefined;
    a.run = undefined;
    this.log(
      a,
      "sign-in ended",
      result.ok === true ? "saved" : (result as { error: ApiError }).error.code,
    );
    a.drop = this.setTimer(() => {
      if (this.attempts.get(a.userId) === a) this.attempts.delete(a.userId);
    }, this.keepMs);
    return result;
  }

  private async mint(a: Attempt, code: string, name: string | undefined): Promise<Result> {
    const run = a.run;
    if (!run) return { ok: false, error: err.failed() };
    // The token is a local of this function only (§5.4 Token lifetime).
    const token = await run.submit(code);
    const mintedAt = this.d.now();
    if (a.ended) return { ok: "aborted" };
    a.state = "verifying";
    let r = await this.d.verify(token);
    if (!r.ok && r.kind === "unreachable") {
      await new Promise((res) => this.setTimer(res, this.retryMs));
      if (a.ended) return { ok: "aborted" };
      r = await this.d.verify(token);
    }
    if (!r.ok)
      return {
        ok: false,
        error:
          r.kind === "rejected"
            ? new ApiError(422, "sign_in_token_rejected", r.message)
            : err.unreachable(),
      };
    const expiresAt = new Date(mintedAt + TOKEN_LIFE_MS);
    if (a.purpose.kind === "create") {
      const credential = await this.d.credentials
        .insertVerified({ name: name as string, kind: "oauth_token", value: token, expiresAt })
        .catch((e) => {
          throw e instanceof ApiError && e.code === "credential_exists" ? err.nameTaken() : e;
        });
      return { ok: true, outcome: { status: 201, credential } };
    }
    const credential = await this.d.credentials
      .replaceVerified(a.purpose.credentialId, token, { expiresAt })
      .catch((e) => {
        throw e instanceof ApiError && e.code === "credential_not_found"
          ? err.credentialDeleted()
          : e;
      });
    return { ok: true, outcome: { status: 200, credential } };
  }

  /** The outcome if it arrives within waitMs, else the attempt as it stands (the route answers 202). */
  private async answer(a: Attempt): Promise<Outcome | AttemptView> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((res) => {
      timer = this.setTimer(() => res(null), this.waitMs);
    });
    try {
      if (a.state === "submitting") {
        const left = await Promise.race([a.gate?.then(() => true), timeout]);
        if (!left) return this.toView(a);
        if (a.ended) throw err.notFound();
        // The name check may have sent it back (TS keeps the narrowing across the await).
        if ((a.state as SignInState) === "awaiting_code")
          throw err.state({ attempt: this.toView(a) });
      }
      const r = await Promise.race([a.outcome as Promise<Result>, timeout]);
      if (r === null) return this.toView(a);
      if (r.ok === "aborted") throw err.notFound();
      if (r.ok) return r.outcome;
      throw r.error;
    } finally {
      if (timer) this.clearTimer(timer);
    }
  }

  private log(a: Attempt, message: "sign-in started" | "sign-in ended", reason: string) {
    this.d.log.info({ userId: a.userId, attemptId: a.attemptId, reason }, message);
  }
}

/** Fixed answers only: a runner reason, one of our own refusals, or `sign_in_failed` for anything else. */
function toError(e: unknown): ApiError {
  if (e instanceof RunFailed)
    return e.reason === "code_rejected" ? err.codeRejected() : err.failed();
  if (e instanceof ApiError) return e;
  return err.failed(); // a caught Error is discarded, never stringified (§6.2)
}
