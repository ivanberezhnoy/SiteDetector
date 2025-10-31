export class SelectorNotFoundError extends Error {
  constructor(
    public siteId: string,
    public selector: string,
    public stage: 'list' | 'ad' | 'phone'
  ) {
    super(`Selector not found at stage='${stage}': ${selector} [${siteId}]`);
    this.name = 'SelectorNotFoundError';
  }
}
