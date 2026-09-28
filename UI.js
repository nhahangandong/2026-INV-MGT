/**
 * [UI TRIGGER] Tự động tạo Menu tương tác trên Google Sheets khi mở file
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  
  ui.createMenu("⚙️ HỆ THỐNG TRUNG TÂM")
    // NHÓM 1: INGESTION (SPOKE -> HUB RAW)
    .addSubMenu(ui.createMenu("📥 1. Đồng bộ dữ liệu Spoke (Ingestion)")
      .addItem("[PO] Đồng bộ Mua hàng theo kỳ...", "promptAndRunPoIngestion")
      .addItem("[SO] Đồng bộ Bán hàng theo kỳ...", "promptAndRunSoIngestion")
      .addItem("[OPENING] Đồng bộ Tồn đầu kỳ...", "promptAndRunOpeningIngestion"))

    // NHÓM 2: STAGING PIPELINE (RAW -> STG)
    .addSubMenu(ui.createMenu("⚡ 2. Chạy Staging Pipeline")
      .addItem("[PO] Chạy Staging Mua hàng...", "runStagingPO")
      .addItem("[SO] Chạy Staging Bán hàng...", "runStagingSO")
      .addItem("[OPENING] Chạy Staging Tồn đầu kỳ...", "runStagingOpening"))

    .addSeparator()

    // NHÓM 3: QUẢN LÝ MAP_RULE & SKU
    .addSubMenu(ui.createMenu("🛠️ 3. Quản lý MAP_RULE & SKU")
      .addItem("1. Gợi ý tên chuẩn (AUTO_MAP_RULE)", "UI_applyAutoMapNamesAll")
      .addItem("2. Sinh mã SKU & Đồng bộ ITEM_MASTER", "UI_generateAndSyncItemCodes")
      .addSeparator()
      .addItem("3. Đồng bộ tên/mã chuẩn sang Staging", "UI_syncMapRulesToStagingAll"))

    // NHÓM 4: CHUẨN HÓA MASTER DATA (UC & INVENTORY SKU)
    .addSubMenu(ui.createMenu("📦 4. Chuẩn hóa Master Data")
      .addItem("1. Trích xuất đơn vị lẻ (Bootstrap UNIT_CONVERSION)", "UI_bootstrapUnitConversion")
      .addItem("2. Gán mã Nguyên liệu/BOM (AUTO_SKU_RULE)", "UI_applyAutoSkuRules"))

    .addSeparator()

    // NHÓM 5: TỔNG HỢP FACT DATA & RECALCULATE
    .addSubMenu(ui.createMenu("📊 5. Tổng hợp Fact Data")
      .addItem("Tổng hợp Fact Inbound (Nhập kho)...", "UI_promptAndRunFactInbound")
      .addItem("Tổng hợp Fact Outbound (Tiêu hao & Food Cost)...", "UI_promptAndRunFactOutbound")
      .addItem("Chạy toàn bộ Fact theo kỳ...", "UI_promptAndRunAllFact")
      .addSeparator()
      .addItem("🔄 [Cập nhật lại UC] PO -> Fact Inbound", "UI_recalculateFactPO")
      .addItem("🔄 [Cập nhật lại UC] SO -> Fact Outbound", "UI_recalculateFactSO"))

    .addSeparator()
    .addItem("📋 Cập nhật Danh mục Bảng (TABLES)", "generateTablesCatalogSheet")
    .addToUi();
}

// ==========================================
// HELPER FACTORY
// ==========================================

function _getStagingService() {
  const tableRepo = new TableRepository();
  const schemaService = new SchemaService(tableRepo);
  const sysConfigService = new SysConfigService(tableRepo);
  return new DataStagingService(tableRepo, schemaService, sysConfigService);
}

// ==========================================
// 1. INGESTION & STAGING ENTRY POINTS
// ==========================================

function promptAndRunPoIngestion() { promptAndRunIngestion("PO"); }
function promptAndRunSoIngestion() { promptAndRunIngestion("SO"); }
function promptAndRunOpeningIngestion() { promptAndRunIngestion("OPENING"); }

function promptAndRunIngestion(sourceType) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    `Đồng bộ dữ liệu ${sourceType}`,
    'Nhập danh sách kỳ cần đồng bộ (Ví dụ: 202603 hoặc 202603, 202604).\nĐể trống và nhấn OK nếu muốn chạy cho TOÀN BỘ kỳ:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    const inputStr = response.getResponseText().trim();
    const periods = inputStr ? inputStr.split(',').map(p => p.trim()).filter(p => p.length > 0) : [];
    
    const controller = new IngestController();
    controller.runIngestion(sourceType, periods);
  }
}

// ==========================================
// 2. QUẢN LÝ MAP_RULE & SKU ENTRY POINTS
// ==========================================

/**
 * Thao tác 3.1: Quét RAW nạp mặt hàng mới & Gợi ý tên chuẩn từ AUTO_MAP_RULE
 */
function UI_applyAutoMapNamesAll() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang tự động nạp RAW và gợi ý tên chuẩn cho PO & SO...", "Hệ Thống", 5);
    const stagingService = _getStagingService();
    
    const countPO = stagingService.applyAutoMapNamesToMapRules("PO", true);
    const countSO = stagingService.applyAutoMapNamesToMapRules("SO", true);
    const total = countPO + countSO;

    ui.alert(
      "Hoàn tất Gợi ý Tên chuẩn!", 
      `• Đã quét RAW & gợi ý tên chuẩn (item_name) cho ${total} dòng trên MAP_RULE.\n` +
      `  - PO: ${countPO} dòng\n` +
      `  - SO: ${countSO} dòng\n\n` +
      `👉 Bạn có thể kiểm tra/sửa trực tiếp cột [item_name] trên Sheet MAP_RULE trước khi bấm Sinh mã SKU.`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Lỗi!", `Không thể áp dụng Auto Map: ${error.message}`, ui.ButtonSet.OK);
  }
}

/**
 * Thao tác 3.2: Sinh mã item_code tự động từ item_name chuẩn & Bảo lưu ITEM_MASTER
 */
function UI_generateAndSyncItemCodes() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang sinh mã item_code từ item_name chuẩn...", "Hệ Thống", 5);
    const stagingService = _getStagingService();
    
    const count = stagingService.generateAndSyncItemCodes();

    ui.alert(
      "Thành công!", 
      `• Đã sinh mới ${count} mã item_code.\n` +
      `• Đã đồng bộ sang ITEM_MASTER và bảo lưu nguyên vẹn các cột cấu hình cũ!`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Lỗi!", `Không thể sinh mã item_code: ${error.message}`, ui.ButtonSet.OK);
  }
}

/**
 * Thao tác 3.3: Cập nhật cặp (item_name, item_code) từ MAP_RULE sang các bảng Staging
 */
function UI_syncMapRulesToStagingAll() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang đồng bộ danh mục chuẩn sang các bảng Staging...", "Hệ Thống", 5);
    const stagingService = _getStagingService();
    
    const countPO = stagingService.updateStagingMappedFields("PO");
    const countSO = stagingService.updateStagingMappedFields("SO");
    const countOp = stagingService.updateStagingMappedFields("OPENING");

    ui.alert(
      "Đồng bộ Staging thành công!", 
      `Đã cập nhật lại item_name và item_code sang dữ liệu Staging:\n` +
      `• Staging PO: ${countPO} dòng\n` +
      `• Staging SO: ${countSO} dòng\n` +
      `• Staging OPENING: ${countOp} dòng`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Lỗi!", `Không thể đồng bộ sang Staging: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 3. CHUẨN HÓA MASTER DATA (UC & INVENTORY SKU)
// ==========================================

/**
 * Thao tác 4.1: Trích xuất các cặp đơn vị lẻ từ Staging sang UNIT_CONVERSION
 */
function UI_bootstrapUnitConversion() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang trích xuất đơn vị tính lẻ từ Staging...", "Hệ Thống", 5);
    const stagingService = _getStagingService();
    
    const addedCount = stagingService.bootstrapUnitConversionFromStaging();
    
    if (addedCount > 0) {
      ui.alert("Thành công", `Đã trích xuất và thêm mới ${addedCount} cặp đơn vị lẻ vào bảng UNIT_CONVERSION.`, ui.ButtonSet.OK);
    } else {
      ui.alert("Thông báo", "Không phát hiện đơn vị tính lẻ mới nào cần bổ sung.", ui.ButtonSet.OK);
    }
  } catch (error) {
    ui.alert("Lỗi hệ thống", `Không thể bootstrap đơn vị quy đổi: ${error.message}`, ui.ButtonSet.OK);
  }
}

/**
 * Thao tác 4.2: Tự động gán mã Nguyên liệu (inventory_sku) cho ITEM_MASTER
 */
function UI_applyAutoSkuRules() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "Xác nhận gán mã Nguyên liệu / Thành phần",
    "Bạn có muốn ghi đè các mã inventory_sku đã có sẵn không?\n\n- Chọn YES: Ghi đè toàn bộ theo AUTO_SKU_RULE.\n- Chọn NO: Chỉ điền cho các SKU chưa có mã.",
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (response === ui.Button.CANCEL) return;

  const overwrite = (response === ui.Button.YES);

  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang thực hiện gán mã nguyên liệu cho ITEM_MASTER...", "Hệ Thống", 5);
    const stagingService = _getStagingService();
    
    const updatedCount = stagingService.applyAutoSkuRules(overwrite);
    
    ui.alert("Thành công", `Đã tự động gán/cập nhật mã inventory_sku cho ${updatedCount} mặt hàng trong ITEM_MASTER.`, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert("Lỗi hệ thống", `Không thể gán mã nguyên liệu: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 4. FACT & RECALCULATE ENTRY POINTS
// ==========================================

function UI_recalculateFactPO() { _executeRecalculateFact("PO"); }
function UI_recalculateFactSO() { _executeRecalculateFact("SO"); }

function _executeRecalculateFact(sourceGroup) {
  const controller = new FactController();
  const ui = SpreadsheetApp.getUi();

  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang cập nhật lại quy đổi đơn vị sang Fact...", "Hệ Thống", 5);
    const count = controller.recalculateOnUnitConversionChange(sourceGroup);

    ui.alert(
      "Đồng bộ thành công!", 
      `Đã cập nhật hệ số quy đổi mới từ UNIT_CONVERSION trực tiếp sang FACT [${sourceGroup}]:\n` +
      `• Tổng số dòng Fact được tính toán lại: ${count} dòng.`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Lỗi!", `Không thể tính lại Fact cho ${sourceGroup}: ${error.message}`, ui.ButtonSet.OK);
  }
}

function UI_promptAndRunFactInbound() {
  const period = _promptForPeriod("Tổng hợp Fact Inbound");
  if (period !== false) {
    const controller = new FactController();
    const count = controller.runFactInbound(period);
    SpreadsheetApp.getUi().alert(`Đã tổng hợp ${count} dòng Fact Inbound (Kỳ: ${period || "ALL"})!`);
  }
}

function UI_promptAndRunFactOutbound() {
  const period = _promptForPeriod("Tổng hợp Fact Outbound");
  if (period !== false) {
    const controller = new FactController();
    const count = controller.runFactOutbound(period);
    SpreadsheetApp.getUi().alert(`Đã tổng hợp ${count} dòng Fact Outbound (Kỳ: ${period || "ALL"})!`);
  }
}

function UI_promptAndRunAllFact() {
  const period = _promptForPeriod("Tổng hợp Toàn bộ Fact");
  if (period !== false) {
    const controller = new FactController();
    const res = controller.runAllFact(period);
    SpreadsheetApp.getUi().alert(
      "Hoàn tất!", 
      `Kết quả tổng hợp Fact (Kỳ: ${period || "ALL"}):\n` +
      `- Fact Inbound: ${res.countInbound} dòng\n` +
      `- Fact Outbound: ${res.countOutbound} dòng`, 
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  }
}

function _promptForPeriod(actionTitle) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    actionTitle,
    'Nhập kỳ cần xử lý (Ví dụ: 202603).\nĐể trống và nhấn OK nếu muốn chạy cho TOÀN BỘ kỳ:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    const input = response.getResponseText().trim();
    return input !== "" ? input : null;
  }
  return false;
}
