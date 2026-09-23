/**
 * [CONTROLLER] StagingController - Điều phối chạy thực tế tầng Staging
 */
function runStagingPO() {
  // Controller cấu hình bộ khóa chính rõ ràng cho PO Staging
  const poPrimaryKeys = ["invoice_code", "line_no"];
  _executeStagingFlow("PO", poPrimaryKeys);
}

function runStagingSO() {
  // Controller cấu hình bộ khóa chính rõ ràng cho SO Staging
  const soPrimaryKeys = ["invoice_code", "line_no"];
  _executeStagingFlow("SO", soPrimaryKeys);
}

/**
 * Điều phối chung luồng Staging
 * @param {string} sourceType - "PO" hoặc "SO"
 * @param {Array<string>} primaryKeys - Danh sách khóa chính
 */
/**
 * [CONTROLLER] StagingController - Chỉ giữ nhiệm vụ điều phối
 */
function runStagingPO() {
  _executeStagingFlow("PO", ["invoice_code", "line_no"]);
}

function runStagingSO() {
  _executeStagingFlow("SO", ["invoice_code", "line_no"]);
}

function _executeStagingFlow(sourceType, primaryKeys) {
  Logger.log(`=== BẮT ĐẦU CHẠY STAGING LAYER [${sourceType}] ===`);
  
  const tableRepo = new TableRepository(); 
  const schemaService = new SchemaService(tableRepo);
  const stagingService = new DataStagingService(tableRepo, schemaService);

  try {
    const rawTableName = sourceType === "PO" ? "raw_po_invoice" : "raw_so_invoice";
    const targetStgName = sourceType === "PO" ? "stg_po_invoice" : "stg_so_invoice";

    // Service tự xử lý toàn bộ từ Bootstrap, Sync ĐVT đến Transform dữ liệu
    const result = stagingService.runStaging(sourceType, primaryKeys);

    Logger.log(`=== CHẠY STAGING ${sourceType} THÀNH CÔNG ===`);
    SpreadsheetApp.getUi().alert(
      "Thành công!", 
      `Đã chuyển đổi hoàn tất ${result.stgTransformedCount} dòng vào bảng ${targetStgName}.`, 
      SpreadsheetApp.getUi().ButtonSet.OK
    );

  } catch (error) {
    Logger.log(`[ERROR] Lỗi thực thi Staging ${sourceType}: ${error.message}`);
    SpreadsheetApp.getUi().alert("Lỗi", `Đã xảy ra lỗi: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}
