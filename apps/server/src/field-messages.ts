/** Server field messages. Spec §8: at most 40 characters, no interpolated user value, one rule each. */
export const FIELD_MSG = {
  absolutePath: "Enter an absolute path.",
  noFolder: "No folder at this path.",
  folderInUse: "Another project uses this folder.",
  chooseCredential: "Choose a credential.",
  chooseManager: "Choose an active agent.",
  projectRemoved: "A chosen project was removed.",
  slugInvalid: "Invalid slug.",
  slugTaken: "That slug is taken.",
  slugFolderExists: "That slug's folder already exists.",
  reportsCycle: "That would create a reporting loop.",
  invalidTime: "Not a valid time.",
  tokenRejected: "Claude rejected this token.",
  apiKeyRejected: "Claude rejected this API key.",
  claudeUnreachable: "Couldn't reach Claude. Try again.",
} as const;
