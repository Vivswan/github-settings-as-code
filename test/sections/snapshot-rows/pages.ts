import { pagesSection } from "../../../src/sections/pages/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: pagesSection,
  // The server fields (url, status, html_url, the certificate) fall away.
  live: {
    pages: {
      url: "https://api.github.com/repos/o/r/pages",
      status: "built",
      cname: "docs.example.com",
      custom_404: false,
      html_url: "https://o.github.io/r/",
      build_type: "workflow",
      source: { branch: "main", path: "/" },
      public: true,
      https_certificate: { state: "approved", description: "ok", domains: ["docs.example.com"] },
      https_enforced: true,
      protected_domain_state: null,
      pending_domain_unverified_at: null,
    },
  },
  expected: {
    value: {
      build_type: "workflow",
      source: { branch: "main", path: "/" },
      cname: "docs.example.com",
      https_enforced: true,
      public: true,
    },
    notes: [],
  },
};
