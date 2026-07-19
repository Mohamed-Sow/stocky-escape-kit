export const RUN_HISTORY_PAGE_SIZE = 25;
export const FINDINGS_PAGE_SIZE = 25;

export function resolveRunHistoryPage(value: string | null, total: number) {
  const safeTotal = Math.max(0, total);
  const pageCount = Math.max(1, Math.ceil(safeTotal / RUN_HISTORY_PAGE_SIZE));
  const parsed = Number(value);
  const requestedPage = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  const page = Math.min(requestedPage, pageCount);

  return {
    page,
    pageCount,
    pageSize: RUN_HISTORY_PAGE_SIZE,
    skip: (page - 1) * RUN_HISTORY_PAGE_SIZE,
    total: safeTotal,
  };
}

export function resolveFindingsPage(value: string | null, total: number) {
  const safeTotal = Math.max(0, total);
  const pageCount = Math.max(1, Math.ceil(safeTotal / FINDINGS_PAGE_SIZE));
  const parsed = Number(value);
  const requestedPage = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  const page = Math.min(requestedPage, pageCount);

  return {
    page,
    pageCount,
    pageSize: FINDINGS_PAGE_SIZE,
    skip: (page - 1) * FINDINGS_PAGE_SIZE,
    total: safeTotal,
  };
}
