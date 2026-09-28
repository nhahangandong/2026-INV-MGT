/**
 * Triggers chạy Staging
 */
function runStagingPO() { _executeStagingFlow("PO"); }
function runStagingSO() { _executeStagingFlow("SO"); }
function runStagingOpening() { _executeStagingFlow("OPENING"); }
function runStagingAdjustment() { _executeStagingFlow("INVENTORY_ADJUSTMENT"); }

/**
 * Hàm điều phối chung cho tất cả các nút bấm Staging
 */
function _executeStagingFlow(sourceGroup) {
  const normGroup = String(sourceGroup).toUpperCase().trim();
  
  const periodFilter = _promptUserForPeriod(normGroup);
  if (periodFilter === null) return;

  const filters = periodFilter ? { key: "period", values: [periodFilter] } : null;

  Logger.log(`=== BẮT ĐẦU CHẠY STAGING LAYER [${normGroup}] ===`);
  
  const tableRepo = new TableRepository(); 
  const schemaService = new SchemaService(tableRepo);
  const sysConfigService = new SysConfigService(tableRepo);
  const stagingService = new DataStagingService(tableRepo, schemaService, sysConfigService);

  try {
    const count = stagingService.runStaging(normGroup, null, filters);

    const filterInfo = periodFilter ? ` (Kỳ: ${periodFilter})` : " (Toàn bộ kỳ)";
    SpreadsheetApp.getUi().alert(
      "Thành công!", 
      `Đã chuyển đổi hoàn tất ${count} dòng dữ liệu cho nguồn [${normGroup}]${filterInfo}.`, 
      SpreadsheetApp.getUi().ButtonSet.OK
    );

    return count;

  } catch (error) {
    Logger.log(`[ERROR] Lỗi thực thi Staging ${normGroup}: ${error.message}`);
    SpreadsheetApp.getUi().alert("Lỗi Thực Thi Staging", `Chi tiết lỗi: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    throw error;
  }
}

/**
 * Hộp thoại prompt nhập kỳ
 */
function _promptUserForPeriod(sourceGroup) {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    `Lọc dữ liệu Staging [${sourceGroup}]`,
    "Nhập Kỳ cần lọc (định dạng YYYYMM, ví dụ: 202604).\nĐể trống và bấm OK nếu muốn chạy toàn bộ dữ liệu:",
    ui.ButtonSet.OK_CANCEL
  );

  const button = result.getSelectedButton();
  const text = result.getResponseText().trim();

  if (button !== ui.Button.OK) return null;

  if (text !== "" && !/^\d{6}$/.test(text)) {
    ui.alert("Cảnh báo", "Kỳ nhập vào không đúng định dạng YYYYMM (ví dụ: 202604). Vui lòng thử lại!", ui.ButtonSet.OK);
    return null;
  }

  return text;
}




/**
 * Controller kích hoạt Bootstrap Đơn vị tính quy đổi từ Staging sang UNIT_CONVERSION
 */
function menuBootstrapUnitConversion() {
  const ui = SpreadsheetApp.getUi();
  try {
    const stagingService = Container.getDataStagingService(); // Lấy instance qua Container/DI
    const addedCount = stagingService.bootstrapUnitConversionFromStaging();
    
    if (addedCount > 0) {
      ui.alert("Thành công", `Đã trích xuất và thêm mới ${addedCount} cặp đơn vị lẻ vào bảng UNIT_CONVERSION.`, ui.ButtonSet.OK);
    } else {
      ui.alert("Thông báo", "Không phát hiện đơn vị tính lẻ mới nào cần bổ sung.", ui.ButtonSet.OK);
    }
  } catch (err) {
    Logger.log(`[ERROR] menuBootstrapUnitConversion: ${err.stack}`);
    ui.alert("Lỗi hệ thống", `Không thể bootstrap đơn vị quy đổi: ${err.message}`, ui.ButtonSet.OK);
  }
}

/**
 * Controller kích hoạt Tự động gán mã Nguyên liệu (ingredient_code) cho ITEM_MASTER
 */
function menuApplyAutoSkuRules() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "Xác nhận gán mã Nguyên liệu",
    "Bạn có muốn ghi đè các mã ingredient_code đã có sẵn không?\n\n- Chọn YES: Ghi đè toàn bộ theo AUTO_INGREDIENT_RULE.\n- Chọn NO: Chỉ điền cho các SKU chưa có mã.",
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (response === ui.Button.CANCEL) return;

  const overwrite = (response === ui.Button.YES);

  try {
    const stagingService = Container.getDataStagingService();
    const updatedCount = stagingService.applyAutoSkuRules(overwrite);
    
    ui.alert("Thành công", `Đã tự động gán/cập nhật mã ingredient_code cho ${updatedCount} mặt hàng trong ITEM_MASTER.`, ui.ButtonSet.OK);
  } catch (err) {
    Logger.log(`[ERROR] menuApplyAutoSkuRules: ${err.stack}`);
    ui.alert("Lỗi hệ thống", `Không thể gán mã nguyên liệu: ${err.message}`, ui.ButtonSet.OK);
  }
}
