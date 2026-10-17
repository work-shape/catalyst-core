// Paths of the outside sample service, kept here because tests name platform operations
// through their catalog and raw /api paths are confined to test support.
export const accountingRestPaths = {
  clients: "/api/accounting/clients",
  postings: "/api/accounting/postings",
  fiscalYears: (clientId: number) => `/api/accounting/clients/${clientId}/fiscal-years`,
  health: "/api/monitoring/instance/demo-local/datev-connect-health"
};
