/** Form-level and web-only check messages. Spec §8: at most 40 characters, no interpolated user value, one rule each. */
export const FORM_MSG = {
  nameTaken: "That name is taken.",
  agentEnded: "That agent has ended; pick another.",
  agentMissing: "No such agent; pick another.",
  templateErrors: "That template has errors; fix it first.",
  displayNameLength: "Use 80 characters or fewer.",
  descriptionLength: "Use 500 characters or fewer.",
  unreachable: "Couldn't reach the server. Try again.",
  templateNameChars: "Use 2 to 40 letters, digits or hyphens.",
  addCredentialFailed: "Couldn't add the credential.",
  addProjectFailed: "Couldn't add the project.",
  addSecretFailed: "Couldn't add the secret.",
  createTaskFailed: "Couldn't create the task. Try again.",
  displayNameRequired: "Use 1 to 80 characters.",
} as const;
