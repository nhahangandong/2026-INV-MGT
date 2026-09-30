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

    // NHÓM 3: QUẢN LÝ MAP_RULE & SKU (ĐÃ CẢI TIẾN LƯỢC ĐỒ NGỮ CẢNH)
    .addSubMenu(ui.createMenu("🛠️ 3. Quản lý MAP_RULE & SKU")
      .addItem("1. Gợi ý Tên chuẩn theo Ngữ cảnh (AUTO_MAP_RULE)", "UI_applyAutoMapNamesAll")
      .addItem("2. Sinh mã SKU & Đồng bộ ITEM_MASTER", "UI_generateAndSyncItemCodes")
      .addItem("3. Đồng bộ tên/mã chuẩn sang Staging", "UI_syncMapRulesToStagingAll")
      .addSeparator()
      .addItem("🚀 [1-Click] Chạy Toàn bộ Pipeline Map -> SKU -> Staging", "UI_runFullMappingPipeline"))

    // NHÓM 4: CHUẨN HÓA MASTER DATA (UC & INVENTORY SKU)
    .addSubMenu(ui.createMenu("📦 4. Chuẩn hóa Master Data")
      .addItem("1. Trích xuất đơn vị lẻ (Bootstrap UNIT_CONVERSION)", "UI_bootstrapUnitConversion")
      .addItem("2. Gán mã Nguyên liệu/BOM (AUTO_SKU_RULE)", "UI_applyAutoSkuRules"))

    .addSeparator()

    // NHÓM 5: ĐỊNH MỨC BOM & TỔNG HỢP FACT (COGS)
    .addSubMenu(ui.createMenu("📊 5. Định mức BOM & Fact Data (COGS)")
      .addItem("1. Khởi tạo / Cập nhật Danh mục BOM (BOM_RECIPE)", "UI_bootstrapBomRecipe")
      .addItem("2. Tổng hợp Fact Inbound (Nhập kho)...", "UI_promptAndRunFactInbound")
      .addItem("3. Tổng hợp Fact Outbound (Bung BOM & Food Cost)...", "UI_promptAndRunFactOutbound")
      .addSeparator()
      .addItem("🚀 [1-Click] Chạy Toàn bộ Pipeline BOM & Fact theo kỳ...", "UI_promptAndRunAllFact")
      .addSeparator()
      .addItem("🔄 [Cập nhật lại UC] PO -> Fact Inbound", "UI_recalculateFactPO")
      .addItem("🔄 [Cập nhật lại UC] SO -> Fact Outbound", "UI_recalculateFactSO"))

    .addSeparator()
    .addItem("📋 Cập nhật Danh mục Bảng (TABLES)", "generateTablesCatalogSheet")
    .addToUi();
}

// ==========================================
// HELPER FACTORIES
// ==========================================

function _getStagingService() {
  const tableRepo = new TableRepository();
  const schemaService = new SchemaService(tableRepo);
  const sysConfigService = new SysConfigService(tableRepo);
  return new DataStagingService(tableRepo, schemaService, sysConfigService);
}

function _getFactController() {
  const tableRepo = new TableRepository();
  const schemaService = new SchemaService(tableRepo);
  const sysConfigService = new SysConfigService(tableRepo);
  return new FactController(tableRepo, schemaService, sysConfigService);
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
 * Thao tác 3.1: Quét RAW nạp mặt hàng mới & Gợi ý tên chuẩn theo Ngữ cảnh (PO, SO, OPENING)
 */
function UI_applyAutoMapNamesAll() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang phân tích bối cảnh & gợi ý tên chuẩn cho PO, SO, OPENING...", "Hệ Thống", 5);
    const stagingService = _getStagingService();
    
    const countPO = stagingService.applyAutoMapNamesToMapRules("PO", true);
    const countSO = stagingService.applyAutoMapNamesToMapRules("SO", true);
    const countOp = stagingService.applyAutoMapNamesToMapRules("OPENING", true);
    const total = countPO + countSO + countOp;

    ui.alert(
      "Hoàn tất Gợi ý Tên chuẩn theo Ngữ cảnh!", 
      `• Đã gợi ý tên chuẩn (item_name) cho ${total} dòng trên MAP_RULE:\n` +
      `  - PO (Hóa đơn mua): ${countPO} dòng\n` +
      `  - SO (Hóa đơn bán): ${countSO} dòng\n` +
      `  - OPENING (Tồn kho): ${countOp} dòng\n\n` +
      `👉 Lưu ý: Nguồn OPENING đã được xử lý theo cơ chế cách ly Rule Chi phí/MST.`, 
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

/**
 * Thao tác 3.4: Tích hợp 1-Click tự động chạy toàn bộ quy trình Mapping
 */
function UI_runFullMappingPipeline() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("🚀 Đang chạy chuỗi Auto-Map -> SKU -> Đồng bộ Staging...", "Hệ Thống", 10);
    const stagingService = _getStagingService();

    // Bước 1: Auto-map theo bối cảnh
    const countPO = stagingService.applyAutoMapNamesToMapRules("PO", true);
    const countSO = stagingService.applyAutoMapNamesToMapRules("SO", true);
    const countOp = stagingService.applyAutoMapNamesToMapRules("OPENING", true);

    // Bước 2: Sinh mã SKU
    const newSkuCount = stagingService.generateAndSyncItemCodes();

    // Bước 3: Đẩy sang Staging
    const stgPO = stagingService.updateStagingMappedFields("PO");
    const stgSO = stagingService.updateStagingMappedFields("SO");
    const stgOp = stagingService.updateStagingMappedFields("OPENING");

    ui.alert(
      "🚀 Hoàn tất Pipeline Chuẩn hóa Mapping!", 
      `1. Auto Map: Gợi ý ${countPO + countSO + countOp} dòng (PO: ${countPO}, SO: ${countSO}, OPENING: ${countOp})\n` +
      `2. SKU Master: Sinh mới ${newSkuCount} mã SKU.\n` +
      `3. Staging Sync: Đã cập nhật sang Staging (PO: ${stgPO}, SO: ${stgSO}, OPENING: ${stgOp}).`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Lỗi Pipeline!", `Lỗi thực thi: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 3. CHUẨN HÓA MASTER DATA (UC & INVENTORY SKU)
// ==========================================

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
// 4. BOM & FACT ENTRY POINTS (COGS)
// ==========================================

/**
 * Thao tác 5.1: Khởi tạo/Trích xuất cây định mức BOM từ ITEM_MASTER
 */
function UI_bootstrapBomRecipe() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang đồng bộ danh mục BOM từ ITEM_MASTER...", "Hệ Thống", 5);
    
    const tableRepo = new TableRepository();
    const bomService = new BomService(tableRepo);
    const addedCount = bomService.bootstrapBomFromItemMaster();

    if (addedCount > 0) {
      ui.alert(
        "Thành công", 
        `• Đã trích xuất và khởi tạo thành công ${addedCount} công thức/món mới vào BOM_RECIPE.`, 
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        "Thông báo", 
        "Tất cả món bán và nguyên liệu đã có sẵn trong bảng BOM_RECIPE, không có dòng mới nào cần tạo.", 
        ui.ButtonSet.OK
      );
    }
  } catch (error) {
    ui.alert("Lỗi hệ thống", `Không thể khởi tạo danh mục BOM: ${error.message}`, ui.ButtonSet.OK);
  }
}

/**
 * Thao tác 5.2: Tổng hợp Fact Inbound từ Staging PO
 */
function UI_promptAndRunFactInbound() {
  const period = _promptForPeriod("Tổng hợp Fact Inbound (Nhập kho)");
  if (period !== false) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast("Đang tính toán Fact Inbound...", "Hệ Thống", 5);
      const controller = _getFactController();
      const count = controller.runFactInbound(period);
      
      SpreadsheetApp.getUi().alert(
        "Thành công", 
        `Đã xử lý & ghi thành công ${count} dòng vào bảng FACT_INBOUND (Kỳ: ${period || "TẤT CẢ"}).`, 
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (error) {
      SpreadsheetApp.getUi().alert("Lỗi!", `Không thể tính Fact Inbound: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }
}

/**
 * Thao tác 5.3: Tổng hợp Fact Outbound (Bung đệ quy BOM & tính Food Cost)
 */
function UI_promptAndRunFactOutbound() {
  const period = _promptForPeriod("Tổng hợp Fact Outbound (Tiêu hao & Food Cost)");
  if (period !== false) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast("Đang xả BOM đệ quy & tính toán Food Cost...", "Hệ Thống", 5);
      const controller = _getFactController();
      const count = controller.runFactOutbound(period);
      
      SpreadsheetApp.getUi().alert(
        "Thành công", 
        `Đã bung đệ quy BOM & ghi ${count} dòng chi tiết tiêu hao vào FACT_OUTBOUND (Kỳ: ${period || "TẤT CẢ"}).`, 
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (error) {
      SpreadsheetApp.getUi().alert("Lỗi!", `Không thể tính Fact Outbound: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }
}

/**
 * Thao tác 5.4: [1-Click] Chạy toàn bộ chuỗi BOM & Fact (Inbound -> Outbound -> COGS)
 */
function UI_promptAndRunAllFact() {
  const period = _promptForPeriod("🚀 [1-Click] Chạy Toàn bộ Pipeline BOM & Fact Data");
  if (period !== false) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast("🚀 Đang chạy chuỗi Pipeline Fact Inbound -> BOM -> Fact Outbound...", "Hệ Thống", 10);
      
      const tableRepo = new TableRepository();
      const bomService = new BomService(tableRepo);
      const controller = _getFactController();

      // 1. Bootstrap BOM
      const newBomCount = bomService.bootstrapBomFromItemMaster();

      // 2. Fact Inbound & Outbound
      const res = controller.runAllFact(period);

      SpreadsheetApp.getUi().alert(
        "🚀 Hoàn tất Pipeline Fact & COGS!", 
        `Kết quả tổng hợp (Kỳ: ${period || "TẤT CẢ"}):\n` +
        `• BOM Recipe mới: ${newBomCount} công thức\n` +
        `• Fact Inbound (Nhập kho): ${res.countInbound} dòng\n` +
        `• Fact Outbound (Bung BOM & Food Cost): ${res.countOutbound} dòng`, 
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (error) {
      SpreadsheetApp.getUi().alert("Lỗi Pipeline!", `Lỗi thực thi Fact Pipeline: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }
}

function UI_recalculateFactPO() { _executeRecalculateFact("PO"); }
function UI_recalculateFactSO() { _executeRecalculateFact("SO"); }

function _executeRecalculateFact(sourceGroup) {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Đang cập nhật lại quy đổi đơn vị sang Fact...", "Hệ Thống", 5);
    const controller = _getFactController();
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
