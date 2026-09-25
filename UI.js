/**
 * [UI TRIGGER] Tự động tạo Menu tương tác trên Google Sheets khi mở file
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('⚡ Hub Ingestion & Staging Menu')
      .addItem('🚀 [PO] Đồng bộ dữ liệu PO theo kỳ...', 'promptAndRunPoIngestion')
      .addItem('🚀 [SO] Đồng bộ dữ liệu SO theo kỳ...', 'promptAndRunSoIngestion')
      .addSeparator()
      .addItem('⚡ [PO] Chạy toàn bộ Staging PO (Mua hàng)', 'runStagingPO')
      .addItem('⚡ [SO] Chạy toàn bộ Staging SO (Bán hàng)', 'runStagingSO')
      .addSeparator()
      .addItem('🔄 [PO] Cập nhật lại Quy đổi UNIT_CONVERSION -> Staging PO & Master', 'UI_recalculateStagingPO')
      .addItem('🔄 [SO] Cập nhật lại Quy đổi UNIT_CONVERSION -> Staging SO & Master', 'UI_recalculateStagingSO')
      .addSeparator()
      .addSubMenu(ui.createMenu('🛠️ Quản lý MAP_RULE & SKU')
          .addItem('1. [PO] Gợi ý tên chuẩn & Sinh mã SKU', 'UI_applyAutoMapAndGenerateCodes_PO')
          .addItem('2. [SO] Gợi ý tên chuẩn & Sinh mã SKU', 'UI_applyAutoMapAndGenerateCodes_SO')
          .addSeparator()
          .addItem('• [PO] Chỉ gợi ý tên chuẩn (item_name)', 'UI_applyAutoMapNames_PO')
          .addItem('• [PO] Chỉ sinh mã SKU (item_code)', 'UI_generateItemCodes_PO')
          .addItem('• [SO] Chỉ gợi ý tên chuẩn (item_name)', 'UI_applyAutoMapNames_SO')
          .addItem('• [SO] Chỉ sinh mã SKU (item_code)', 'UI_generateItemCodes_SO'))
      .addSeparator()
      .addSubMenu(ui.createMenu('📊 Tổng hợp Fact Data')
          .addItem('1. Tổng hợp Fact Inbound (Nhập kho)...', 'UI_promptAndRunFactInbound')
          .addItem('2. Tổng hợp Fact Outbound (Tiêu hao & Food Cost)...', 'UI_promptAndRunFactOutbound')
          .addSeparator()
          .addItem('⚡ Tổng hợp Fact Inbound (Toàn bộ)', 'UI_runFactInboundAll')
          .addItem('⚡ Tổng hợp Fact Outbound (Toàn bộ)', 'UI_runFactOutboundAll')
          .addItem('🚀 Chạy toàn bộ Fact theo kỳ...', 'UI_promptAndRunAllFact'))
      .addToUi();
}

// ==========================================
// 1. INGESTION PROMPTS
// ==========================================

function promptAndRunPoIngestion() { promptAndRunIngestion("PO"); }
function promptAndRunSoIngestion() { promptAndRunIngestion("SO"); }

function promptAndRunIngestion(sourceType) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    `Đồng bộ dữ liệu ${sourceType}`,
    'Nhập danh sách kỳ cần đồng bộ (Ví dụ: 202607 hoặc 202607, 202608):',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    const inputStr = response.getResponseText().trim();
    if (!inputStr) {
      ui.alert('Vui lòng nhập ít nhất một kỳ hợp lệ!');
      return;
    }
    const periods = inputStr.split(',').map(p => p.trim()).filter(p => p.length > 0);
    const controller = new InvoiceController();
    controller.runIngestion(sourceType, periods);
  }
}

// ==========================================
// 2. MAP_RULE & SKU TRIGGERS
// ==========================================

function UI_applyAutoMapNames_PO() { _executeMapRuleStep("PO", "applyName"); }
function UI_applyAutoMapNames_SO() { _executeMapRuleStep("SO", "applyName"); }
function UI_generateItemCodes_PO() { _executeMapRuleStep("PO", "generateCode"); }
function UI_generateItemCodes_SO() { _executeMapRuleStep("SO", "generateCode"); }
function UI_applyAutoMapAndGenerateCodes_PO() { _executeMapRuleStep("PO", "both"); }
function UI_applyAutoMapAndGenerateCodes_SO() { _executeMapRuleStep("SO", "both"); }

function _executeMapRuleStep(sourceGroup, actionType) {
  const tableRepo = new TableRepository();
  const schemaService = new SchemaService(tableRepo);
  const stagingService = new DataStagingService(tableRepo, schemaService);
  const ui = SpreadsheetApp.getUi();

  try {
    let updatedNames = 0;
    let updatedCodes = 0;

    if (actionType === "applyName" || actionType === "both") {
      updatedNames = stagingService.applyAutoMapNamesToMapRules(sourceGroup);
    }
    if (actionType === "generateCode" || actionType === "both") {
      updatedCodes = stagingService.generateItemCodesForMapRules(sourceGroup);
    }

    let msg = `Đã xử lý xong dữ liệu MAP_RULE cho luồng [${sourceGroup}]:\n`;
    if (actionType === "applyName" || actionType === "both") msg += `- Cập nhật/Gợi ý tên: ${updatedNames} dòng\n`;
    if (actionType === "generateCode" || actionType === "both") msg += `- Sinh/Cập nhật mã SKU: ${updatedCodes} dòng`;

    ui.alert("Thành công!", msg, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert("Lỗi!", `Không thể xử lý MAP_RULE cho ${sourceGroup}: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 3. RECALCULATE STAGING TRIGGERS
// ==========================================

function UI_recalculateStagingPO() { _executeRecalculateStaging("PO"); }
function UI_recalculateStagingSO() { _executeRecalculateStaging("SO"); }

function _executeRecalculateStaging(sourceGroup) {
  const tableRepo = new TableRepository();
  const schemaService = new SchemaService(tableRepo);
  const stagingService = new DataStagingService(tableRepo, schemaService);
  const factController = new FactController();
  const ui = SpreadsheetApp.getUi();

  try {
    const res = stagingService.recalculateStagingBaseValues(sourceGroup);
    
    // Tự động re-process Fact qua FactController
    if (sourceGroup === "PO" || sourceGroup === "INT") {
      factController.runFactInbound();
    } else {
      factController.runFactOutbound();
    }

    ui.alert(
      "Đồng bộ thành công!", 
      `Đã cập nhật hệ số quy đổi mới từ UNIT_CONVERSION cho luồng [${sourceGroup}]:\n` +
      `• Staging (${sourceGroup}): ${res.updatedStg} dòng.\n` +
      `• ITEM_MASTER: ${res.updatedMaster} dòng.\n` +
      `• Đã tự động re-process dữ liệu Fact tương ứng.`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Lỗi!", `Không thể tính lại Staging cho ${sourceGroup}: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 4. FACT TRIGGERS (Gọi qua FactController)
// ==========================================

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

function UI_runFactInboundAll() {
  const controller = new FactController();
  const count = controller.runFactInbound(null);
  SpreadsheetApp.getUi().alert(`Đã tổng hợp ${count} dòng Fact Inbound (Toàn bộ kỳ)!`);
}

function UI_runFactOutboundAll() {
  const controller = new FactController();
  const count = controller.runFactOutbound(null);
  SpreadsheetApp.getUi().alert(`Đã tổng hợp ${count} dòng Fact Outbound (Toàn bộ kỳ)!`);
}

/**
 * Helper Prompt lấy điều kiện lọc period
 */
function _promptForPeriod(actionTitle) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    actionTitle,
    'Nhập kỳ cần xử lý (Ví dụ: 2026-09 hoặc 202609).\nĐể trống và nhấn OK nếu muốn chạy cho TOÀN BỘ kỳ:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    const input = response.getResponseText().trim();
    return input !== "" ? input : null;
  }
  return false;
}
