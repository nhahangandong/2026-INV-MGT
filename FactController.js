/**
 * [CONTROLLER] FactController.js
 * Dieu phoi luong xu ly tong hop du lieu FACT va COGS.
 */
class FactController {
  constructor(tableRepo, schemaService, sysConfigService = null) {
    if (!tableRepo || !schemaService) {
      throw new Error("[FactController] Thieu Dependency bat buoc (tableRepo, schemaService).");
    }
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.sysConfigService = sysConfigService;

    // Khoi tao cac Service phu thuoc voi day du Dependency
    this.bomService = new BomService(this.tableRepo, this.schemaService, this.sysConfigService);
    this.factProcessingService = new FactProcessingService(
      this.tableRepo, 
      this.schemaService, 
      this.sysConfigService, 
      this.bomService
    );
  }

  /**
   * Chay tong hop Fact Inbound
   */
  runFactInbound(periodFilter = null) {
    return this.factProcessingService.processFactInbound(periodFilter);
  }

  /**
   * Chay tong hop Fact Outbound (Bung BOM & Food Cost)
   */
  runFactOutbound(periodFilter = null) {
    return this.factProcessingService.processFactOutbound(periodFilter);
  }

  /**
   * Chay toan bo quy trinh Fact (Inbound -> Outbound)
   */
  runAllFact(periodFilter = null) {
    const countInbound = this.runFactInbound(periodFilter);
    const countOutbound = this.runFactOutbound(periodFilter);

    return {
      countInbound,
      countOutbound
    };
  }

  /**
   * Tinh toan lai Fact khi co thay doi ve quy doi don vi
   */
  recalculateOnUnitConversionChange(sourceGroup = "ALL") {
    return this.factProcessingService.recalculateFactOnUnitConversionChange(sourceGroup);
  }
}
