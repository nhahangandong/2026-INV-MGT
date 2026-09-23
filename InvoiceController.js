/**
 * [CLASS] InvoiceController - Điều phối tổng quát luồng đồng bộ ELT cho các nguồn (PO, SO,...)
 */
class InvoiceController {
  constructor() {
    this.schemaService = new SchemaService();
    const schemaMap = this.schemaService.getSchemaMap();
    
    this.tableRepo = new TableRepository(schemaMap);
    this.sysConfigService = new SysConfigService(this.tableRepo);
    this.ingestionService = new DataIngestionService(this.tableRepo);
  }

  /**
   * Phương thức tổng quát thực thi trích xuất với danh sách kỳ động
   * @param {string} sourceType - Mã định danh nguồn (Ví dụ: "PO", "SO")
   * @param {Array<string>} periods - Mảng các kỳ cần lọc động (Ví dụ: ["202607", "202608"])
   */
  runIngestion(sourceType, periods) {
    const prefix = sourceType.toUpperCase();
    Logger.log(`[CONTROLLER] Bắt đầu tiến trình đồng bộ cho nguồn: ${prefix} với các kỳ: ${periods.join(", ")}`);

    try {
      const fileIdKey = `SPOKE_${prefix}_FILE_ID`;
      const sheetNameKey = `${prefix}_SHEET_NAME`;
      const targetTableKey = `RAW_${prefix}_TABLE`;

      const spokeSpreadsheetId = this.sysConfigService.getConfig(fileIdKey);
      const spokeSheetName = this.sysConfigService.getConfig(sheetNameKey);
      const targetSchemaName = this.sysConfigService.getConfig(targetTableKey);

      if (!spokeSpreadsheetId || !spokeSheetName || !targetSchemaName) {
        throw new Error(`[Controller] Thiếu cấu hình hệ thống cho nguồn '${prefix}'. Kiểm tra lại bảng system_config.`);
      }

      // Xác định tổ hợp khóa chính chuẩn dựa trên Schema
      const keyColumns = ["invoice_code", "line_no"]; 

      // Xây dựng bộ lọc tổng quát (Generic Filter) theo danh sách kỳ truyền vào
      let filterCriteria = null;
      if (periods && periods.length > 0) {
        filterCriteria = {
          columnKey: "period", 
          values: periods
        };
      }

      this.ingestionService.ingestFromSpoke(
        spokeSpreadsheetId,
        spokeSheetName,
        targetSchemaName,
        keyColumns,
        filterCriteria
      );

      Logger.log(`[CONTROLLER] Hoàn tất đồng bộ nguồn ${prefix} thành công.`);
      
      try {
        SpreadsheetApp.getUi().alert(`Đồng bộ thành công dữ liệu [${prefix}] cho các kỳ [${periods.join(", ")}] lên Hub!`);
      } catch (e) {}

    } catch (error) {
      Logger.log(`[ERROR] Lỗi đồng bộ nguồn ${prefix}: ${error.message}`);
      try {
        SpreadsheetApp.getUi().alert(`Lỗi đồng bộ [${prefix}]: ${error.message}`);
      } catch (e) {}
      throw error;
    }
  }
}

