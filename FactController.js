/**
 * [CONTROLLER] FactController.js
 * Entry Point điều phối toàn bộ luồng xử lý Fact Data (Inbound / Outbound)
 */
class FactController {
  constructor() {
    this.tableRepo = new TableRepository();
    this.schemaService = new SchemaService(this.tableRepo);
    this.bomService = new BomService(this.tableRepo, this.schemaService);
  }

  /**
   * Điều phối tổng hợp Fact Inbound
   * @param {string|null} period - Kỳ cần lọc (VD: "2026-09" hoặc "202609"). Nếu null sẽ chạy toàn bộ.
   */
  runFactInbound(period = null) {
    const factService = new FactProcessingService(this.tableRepo, this.schemaService);
    return factService.processFactInbound(period);
  }

  /**
   * Điều phối tổng hợp Fact Outbound
   * @param {string|null} period - Kỳ cần lọc
   */
  runFactOutbound(period = null) {
    const factService = new FactProcessingService(this.tableRepo, this.schemaService, this.bomService);
    return factService.processFactOutbound(period);
  }

  /**
   * Điều phối tổng hợp toàn bộ Fact (Inbound & Outbound)
   * @param {string|null} period - Kỳ cần lọc
   */
  runAllFact(period = null) {
    const countInbound = this.runFactInbound(period);
    const countOutbound = this.runFactOutbound(period);
    return { countInbound, countOutbound };
  }
}
