import { ListField } from "./list-field";
import { CONFIG_COPY } from "./messages";
import { Section } from "./section";

/**
 * Spec §12.2 section 4. Rules are mono; trust notes are prose, in Geist. In agent mode the template's rules (deny
 * rules among them) sit in the read-only "From template" group: an overlay can add a rule, never drop one.
 */
export function PermissionsSection() {
  return (
    <Section title="Permissions">
      <ListField
        field="allow"
        label="Allow rules"
        noun="allow rule"
        mono
        help={CONFIG_COPY.rulesHelp}
      />
      <ListField
        field="deny"
        label="Deny rules"
        noun="deny rule"
        mono
        help={CONFIG_COPY.rulesHelp}
      />
      <ListField
        field="trustNotes"
        label="Trust notes"
        noun="trust note"
        help={CONFIG_COPY.notesHelp}
      />
    </Section>
  );
}
