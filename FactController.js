/**
 * [CONTROLLER] FactController.js
 * Điểm điều phối chính cho các tác vụ tổng hợp Fact và tính toán quy đổi.
 */
class FactController {
  constructor(tableRepo = null, schemaService = null, sysConfigService = null) {
    this.tableRepo = tableRepo || new TableRepository();
    this.schemaService = schemaService || new SchemaService(this.tableRepo);
    this.sysConfigService = sysConfigService || new SysConfigService(this.tableRepo);
    
    // Khởi tạo an toàn cho BomService
    const BomServiceClass = typeof BomService !== 'undefined' ? BomService : (typeof BOMService !== 'undefined' ? BOMService : null);
    this.bomService = BomServiceClass ? new BomServiceClass(this.tableRepo) : null;
  }

  /**
   * Tổng hợp dữ liệu Nhập kho/Hóa đơn vào FACT_INBOUND
   */
  runFactInbound(period = null) {
    const factService = new FactProcessingService(
      this.tableRepo, 
      this.schemaService, 
      this.sysConfigService, 
      this.bomService
    );
    return factService.processFactInbound(period);
  }

  /**
   * Tổng hợp dữ liệu Xuất kho/Bán hàng vào FACT_OUTBOUND
   */
  runFactOutbound(period = null) {
    const factService = new FactProcessingService(
      this.tableRepo, 
      this.schemaService, 
      this.sysConfigService, 
      this.bomService
    );
    return factService.processFactOutbound(period);
  }

  /**
   * Chạy toàn bộ tiến trình Fact
   */
  runAllFact(period = null) {
    const countInbound = this.runFactInbound(period);
    const countOutbound = this.runFactOutbound(period);
    return { countInbound, countOutbound };
  }

  /**
   * Recalculate Fact khi hệ số UNIT_CONVERSION bị thay đổi
   */
  recalculateOnUnitConversionChange(sourceGroup = "ALL") {
    const factService = new FactProcessingService(
      this.tableRepo, 
      this.schemaService, 
      this.sysConfigService, 
      this.bomService
    );
    return factService.recalculateFactOnUnitConversionChange(sourceGroup);
  }
}
