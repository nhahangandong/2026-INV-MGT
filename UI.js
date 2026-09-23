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
      .addSubMenu(ui.createMenu('🛠️ Quản lý MAP_RULES & SKU')
          .addItem('1. [PO] Gợi ý tên chuẩn & Sinh mã SKU', 'UI_applyAutoMapAndGenerateCodes_PO')
          .addItem('2. [SO] Gợi ý tên chuẩn & Sinh mã SKU', 'UI_applyAutoMapAndGenerateCodes_SO')
          .addSeparator()
          .addItem('• [PO] Chỉ gợi ý tên chuẩn (item_name)', 'UI_applyAutoMapNames_PO')
          .addItem('• [PO] Chỉ sinh mã SKU (item_code)', 'UI_generateItemCodes_PO')
          .addItem('• [SO] Chỉ gợi ý tên chuẩn (item_name)', 'UI_applyAutoMapNames_SO')
          .addItem('• [SO] Chỉ sinh mã SKU (item_code)', 'UI_generateItemCodes_SO'))
      .addToUi();
}

function promptAndRunPoIngestion() {
  promptAndRunIngestion("PO");
}

function promptAndRunSoIngestion() {
  promptAndRunIngestion("SO");
}

function promptAndRunIngestion(sourceType) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    `Đồng bộ dữ liệu ${sourceType}`,
    'Nhập danh sách kỳ cần đồng bộ (Ví dụ: 202607 hoặc 202607, 202608):',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() == ui.Button.OK) {
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

    let msg = `Đã xử lý xong dữ liệu MAP_RULES cho luồng [${sourceGroup}]:\n`;
    if (actionType === "applyName" || actionType === "both") msg += `- Cập nhật/Gợi ý tên: ${updatedNames} dòng\n`;
    if (actionType === "generateCode" || actionType === "both") msg += `- Sinh/Cập nhật mã SKU: ${updatedCodes} dòng`;

    ui.alert("Thành công!", msg, ui.ButtonSet.OK);

  } catch (error) {
    ui.alert("Lỗi!", `Không thể xử lý MAP_RULES cho ${sourceGroup}: ${error.message}`, ui.ButtonSet.OK);
  }
}
