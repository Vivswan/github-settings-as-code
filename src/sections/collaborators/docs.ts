import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "direct collaborators + pending invitations",
    notes:
      "invitations for new users, pending ones reconciled (stale permission updated, expired re-sent, undeclared cancelled); the repository owner is never touched",
  },
};
