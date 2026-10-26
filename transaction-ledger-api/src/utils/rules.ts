// Laravel-style validation messages for Zod rules.

type Issue = { input?: unknown };

/** "The x field is required." when missing, "The x field must be <type>." otherwise. */
export const typed = (field: string, type: string) => ({
  error: (issue: Issue) =>
    issue.input === undefined ? `The ${field} field is required.` : `The ${field} field must be ${type}.`,
});

/** "The x field is required." when missing, "The selected x is invalid." otherwise. */
export const selected = (field: string) => ({
  error: (issue: Issue) =>
    issue.input === undefined ? `The ${field} field is required.` : `The selected ${field} is invalid.`,
});
