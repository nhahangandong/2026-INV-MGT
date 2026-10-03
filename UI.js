/**
 * [UI TRIGGER] Tu dong tao Menu tuong tac tren Google Sheets khi mo file
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  
  ui.createMenu("⚙️ HE THONG TRUNG TAM")
    // NHOM 1: INGESTION (SPOKE -> HUB RAW)
    .addSubMenu(ui.createMenu("📥 1. Dong bo du lieu Spoke (Ingestion)")
      .addItem("[PO] Dong bo Mua hang theo ky...", "promptAndRunPoIngestion")
      .addItem("[SO] Dong bo Ban hang theo ky...", "promptAndRunSoIngestion")
      .addItem("[OPENING] Dong bo Ton dau ky...", "promptAndRunOpeningIngestion"))

    // NHOM 2: STAGING PIPELINE (RAW -> STG)
    .addSubMenu(ui.createMenu("⚡ 2. Chay Staging Pipeline")
      .addItem("[PO] Chay Staging Mua hang...", "runStagingPO")
      .addItem("[SO] Chay Staging Ban hang...", "runStagingSO")
      .addItem("[OPENING] Chay Staging Ton dau ky...", "runStagingOpening"))

    .addSeparator()

    // NHOM 3: QUAN LY MAP_RULE & SKU
    .addSubMenu(ui.createMenu("🛠️ 3. Quan ly MAP_RULE & SKU")
      .addItem("1. Goi y Ten chuan theo Ngu canh (AUTO_MAP_RULE)", "UI_applyAutoMapNamesAll")
      .addItem("2. Sinh ma SKU & Dong bo ITEM_MASTER", "UI_generateAndSyncItemCodes")
      .addItem("3. Dong bo ten/ma chuan sang Staging", "UI_syncMapRulesToStagingAll")
      .addSeparator()
      .addItem("🚀 [1-Click] Chay Toan bo Pipeline Map -> SKU -> Staging", "UI_runFullMappingPipeline"))

    // NHOM 4: CHUAN HOA MASTER DATA (UC & INVENTORY SKU)
    .addSubMenu(ui.createMenu("📦 4. Chuan hoa Master Data")
      .addItem("1. Trich xuat don vi le (Bootstrap UNIT_CONVERSION)", "UI_bootstrapUnitConversion")
      .addItem("2. Gan ma Nguyen lieu/BOM (AUTO_SKU_RULE)", "UI_applyAutoSkuRules"))

    .addSeparator()

    // NHOM 5: DINH MUC BOM & TONG HOP FACT (COGS)
    .addSubMenu(ui.createMenu("📊 5. Dinh muc BOM & Fact Data (COGS)")
      .addItem("1. Khoi tao / Cap nhat Danh muc BOM (BOM_RECIPE)", "UI_bootstrapBomRecipe")
      .addItem("2. Tong hop Fact Inbound (Nhap kho)...", "UI_promptAndRunFactInbound")
      .addItem("3. Tong hop Fact Outbound (Bung BOM & Food Cost)...", "UI_promptAndRunFactOutbound")
      .addSeparator()
      .addItem("🚀 [1-Click] Chay Toan bo Pipeline BOM & Fact theo ky...", "UI_promptAndRunAllFact")
      .addSeparator()
      .addItem("🔄 [Cap nhat lai UC] PO -> Fact Inbound", "UI_recalculateFactPO")
      .addItem("🔄 [Cap nhat lai UC] SO -> Fact Outbound", "UI_recalculateFactSO"))

    .addSeparator()

    // NHOM 6: BÁO CÁO TỒN KHO N-X-T (INVENTORY BALANCE)
    .addSubMenu(ui.createMenu("📈 6. Biet Bieu & Ton Kho N-X-T")
      .addItem("📦 Tong hop Bao cao N-X-T (FACT_INVENTORY_BALANCE)...", "UI_promptAndRunInventoryBalance"))

    .addSeparator()
    .addItem("📋 Cap nhat Danh muc Bang (TABLES)", "generateTablesCatalogSheet")
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

function _getInventoryService() {
  const tableRepo = new TableRepository();
  const schemaService = new SchemaService(tableRepo);
  return new InventoryService(tableRepo, schemaService);
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
    `Dong bo du lieu ${sourceType}`,
    'Nhap danh sach ky can dong bo (Vi du: 202603 hoac 202603, 202604).\nDe trong va nhan OK neu muon chay cho TOAN BO ky:',
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
// 2. QUAN LY MAP_RULE & SKU ENTRY POINTS
// ==========================================

function UI_applyAutoMapNamesAll() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Dang phan tich boi canh & goi y ten chuan cho PO, SO, OPENING...", "He Thong", 5);
    const stagingService = _getStagingService();
    
    const countPO = stagingService.applyAutoMapNamesToMapRules("PO", true);
    const countSO = stagingService.applyAutoMapNamesToMapRules("SO", true);
    const countOp = stagingService.applyAutoMapNamesToMapRules("OPENING", true);
    const total = countPO + countSO + countOp;

    ui.alert(
      "Hoan tat Goi y Ten chuan theo Ngu canh!", 
      `• Da goi y ten chuan (item_name) cho ${total} dong tren MAP_RULE:\n` +
      `  - PO (Hoa don mua): ${countPO} dong\n` +
      `  - SO (Hoa don ban): ${countSO} dong\n` +
      `  - OPENING (Ton kho): ${countOp} dong\n\n` +
      `👉 Luu y: Nguon OPENING da duoc xu ly theo co che cach ly Rule Chi phi/MST.`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Loi!", `Khong the ap dung Auto Map: ${error.message}`, ui.ButtonSet.OK);
  }
}

function UI_generateAndSyncItemCodes() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Dang sinh ma item_code tu item_name chuan...", "He Thong", 5);
    const stagingService = _getStagingService();
    
    const count = stagingService.generateAndSyncItemCodes();

    ui.alert(
      "Thanh cong!", 
      `• Da sinh moi ${count} ma item_code.\n` +
      `• Da dong bo sang ITEM_MASTER va bao luu nguyen ven cac cot cau hinh cu!`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Loi!", `Khong the sinh ma item_code: ${error.message}`, ui.ButtonSet.OK);
  }
}

function UI_syncMapRulesToStagingAll() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Dang dong bo danh muc chuan sang cac bang Staging...", "He Thong", 5);
    const stagingService = _getStagingService();
    
    const countPO = stagingService.updateStagingMappedFields("PO");
    const countSO = stagingService.updateStagingMappedFields("SO");
    const countOp = stagingService.updateStagingMappedFields("OPENING");

    ui.alert(
      "Dong bo Staging thanh cong!", 
      `Da cap nhat lai item_name va item_code sang du lieu Staging:\n` +
      `• Staging PO: ${countPO} dong\n` +
      `• Staging SO: ${countSO} dong\n` +
      `• Staging OPENING: ${countOp} dong`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Loi!", `Khong the dong bo sang Staging: ${error.message}`, ui.ButtonSet.OK);
  }
}

function UI_runFullMappingPipeline() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("🚀 Dang chay chuoi Auto-Map -> SKU -> Dong bo Staging...", "He Thong", 10);
    const stagingService = _getStagingService();

    const countPO = stagingService.applyAutoMapNamesToMapRules("PO", true);
    const countSO = stagingService.applyAutoMapNamesToMapRules("SO", true);
    const countOp = stagingService.applyAutoMapNamesToMapRules("OPENING", true);

    const newSkuCount = stagingService.generateAndSyncItemCodes();

    const stgPO = stagingService.updateStagingMappedFields("PO");
    const stgSO = stagingService.updateStagingMappedFields("SO");
    const stgOp = stagingService.updateStagingMappedFields("OPENING");

    ui.alert(
      "🚀 Hoan tat Pipeline Chuan hoa Mapping!", 
      `1. Auto Map: Goi y ${countPO + countSO + countOp} dong (PO: ${countPO}, SO: ${countSO}, OPENING: ${countOp})\n` +
      `2. SKU Master: Sinh moi ${newSkuCount} ma SKU.\n` +
      `3. Staging Sync: Da cap nhat sang Staging (PO: ${stgPO}, SO: ${stgSO}, OPENING: ${stgOp}).`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Loi Pipeline!", `Loi thuc thi: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 3. CHUAN HOA MASTER DATA (UC & INVENTORY SKU)
// ==========================================

function UI_bootstrapUnitConversion() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Dang trich xuat don vi tinh le tu Staging...", "He Thong", 5);
    const stagingService = _getStagingService();
    
    const addedCount = stagingService.bootstrapUnitConversionFromStaging();
    
    if (addedCount > 0) {
      ui.alert("Thanh cong", `Da trich xuat va them moi ${addedCount} cap don vi le vao bang UNIT_CONVERSION.`, ui.ButtonSet.OK);
    } else {
      ui.alert("Thong bao", "Khong phat hien don vi tinh le moi nao can bo sung.", ui.ButtonSet.OK);
    }
  } catch (error) {
    ui.alert("Loi he thong", `Khong the bootstrap don vi quy doi: ${error.message}`, ui.ButtonSet.OK);
  }
}

function UI_applyAutoSkuRules() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "Xac nhan gan ma Nguyen lieu / Thanh phan",
    "Ban co muon ghi de cac ma inventory_sku da co san khong?\n\n- Chon YES: Ghi de toan bo theo AUTO_SKU_RULE.\n- Chon NO: Chi dien cho cac SKU chua co ma.",
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (response === ui.Button.CANCEL) return;

  const overwrite = (response === ui.Button.YES);

  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Dang thuc hien gan ma nguyen lieu cho ITEM_MASTER...", "He Thong", 5);
    const stagingService = _getStagingService();
    
    const updatedCount = stagingService.applyAutoSkuRules(overwrite);
    
    ui.alert("Thanh cong", `Da tu dong gan/cap nhat ma inventory_sku cho ${updatedCount} mat hang trong ITEM_MASTER.`, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert("Loi he thong", `Khong the gan ma nguyen lieu: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 4. BOM & FACT ENTRY POINTS (COGS)
// ==========================================

function UI_bootstrapBomRecipe() {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Dang dong bo danh muc BOM tu ITEM_MASTER...", "He Thong", 5);
    
    const tableRepo = new TableRepository();
    const schemaService = new SchemaService(tableRepo);
    const bomService = new BomService(tableRepo, schemaService);
    const addedCount = bomService.bootstrapBomFromItemMaster();

    if (addedCount > 0) {
      ui.alert(
        "Thanh cong", 
        `• Da trich xuat va khoi tao thanh cong ${addedCount} cong thuc/mon moi vao BOM_RECIPE.`, 
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        "Thong bao", 
        "Tat ca mon ban va nguyen lieu da co san trong bang BOM_RECIPE, khong co dong moi nao can tao.", 
        ui.ButtonSet.OK
      );
    }
  } catch (error) {
    ui.alert("Loi he thong", `Khong the khoi tao danh muc BOM: ${error.message}`, ui.ButtonSet.OK);
  }
}

function UI_promptAndRunFactInbound() {
  const period = _promptForPeriod("Tong hop Fact Inbound (Nhap kho)");
  if (period !== false) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast("Dang tinh toan Fact Inbound...", "He Thong", 5);
      const controller = _getFactController();
      const count = controller.runFactInbound(period);
      
      SpreadsheetApp.getUi().alert(
        "Thanh cong", 
        `Da xu ly & ghi thanh cong ${count} dong vao bang FACT_INBOUND (Ky: ${period || "TAT CA"}).`, 
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (error) {
      SpreadsheetApp.getUi().alert("Loi!", `Khong the tinh Fact Inbound: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }
}

function UI_promptAndRunFactOutbound() {
  const period = _promptForPeriod("Tong hop Fact Outbound (Tieu hao & Food Cost)");
  if (period !== false) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast("Dang xa BOM de quy & tinh toan Food Cost...", "He Thong", 5);
      const controller = _getFactController();
      const count = controller.runFactOutbound(period);
      
      SpreadsheetApp.getUi().alert(
        "Thanh cong", 
        `Da bung de quy BOM & ghi ${count} dong chi tiet tieu hao vao FACT_OUTBOUND (Ky: ${period || "TAT CA"}).`, 
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (error) {
      SpreadsheetApp.getUi().alert("Loi!", `Khong the tinh Fact Outbound: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }
}

function UI_promptAndRunAllFact() {
  const period = _promptForPeriod("🚀 [1-Click] Chay Toan bo Pipeline BOM & Fact Data");
  if (period !== false) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast("🚀 Dang chay chuoi Pipeline Fact Inbound -> BOM -> Fact Outbound...", "He Thong", 10);
      
      const tableRepo = new TableRepository();
      const schemaService = new SchemaService(tableRepo);
      const bomService = new BomService(tableRepo, schemaService);
      const controller = _getFactController();

      const newBomCount = bomService.bootstrapBomFromItemMaster();
      const res = controller.runAllFact(period);

      SpreadsheetApp.getUi().alert(
        "🚀 Hoan tat Pipeline Fact & COGS!", 
        `Ket qua tong hop (Ky: ${period || "TAT CA"}):\n` +
        `• BOM Recipe moi: ${newBomCount} cong thuc\n` +
        `• Fact Inbound (Nhap kho): ${res.countInbound} dong\n` +
        `• Fact Outbound (Bung BOM & Food Cost): ${res.countOutbound} dong`, 
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (error) {
      SpreadsheetApp.getUi().alert("Loi Pipeline!", `Loi thuc thi Fact Pipeline: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }
}

function UI_recalculateFactPO() { _executeRecalculateFact("PO"); }
function UI_recalculateFactSO() { _executeRecalculateFact("SO"); }

function _executeRecalculateFact(sourceGroup) {
  const ui = SpreadsheetApp.getUi();
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast("Dang cap nhat lai quy doi don vi sang Fact...", "He Thong", 5);
    const controller = _getFactController();
    const count = controller.recalculateOnUnitConversionChange(sourceGroup);

    ui.alert(
      "Dong bo thanh cong!", 
      `Da cap nhat he so quy doi moi tu UNIT_CONVERSION truc tiep sang FACT [${sourceGroup}]:\n` +
      `• Tong so dong Fact duoc tinh toan lai: ${count} dong.`, 
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert("Loi!", `Khong the tinh lai Fact cho ${sourceGroup}: ${error.message}`, ui.ButtonSet.OK);
  }
}

// ==========================================
// 5. INVENTORY BALANCE ENTRY POINTS (N-X-T)
// ==========================================

function UI_promptAndRunInventoryBalance() {
  const period = _promptForPeriod("Tong hop Bao cao Ton kho N-X-T (FACT_INVENTORY_BALANCE)");
  if (period !== false) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast("Dang tinh toan Ton dau, Nhap, Xuat & Don gia BQ...", "He Thong", 10);
      const inventoryService = _getInventoryService();
      const count = inventoryService.calculatePeriodicInventory(period);

      SpreadsheetApp.getUi().alert(
        "Thanh cong!",
        `Da tong hop va ghi ${count} dong bao cao N-X-T vao bang FACT_INVENTORY_BALANCE (Ky: ${period || "TAT CA"}).`,
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (error) {
      SpreadsheetApp.getUi().alert("Loi!", `Khong the tinh Bao cao N-X-T: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    }
  }
}

// ==========================================
// UTILITY HELPERS
// ==========================================

function _promptForPeriod(actionTitle) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    actionTitle,
    'Nhap ky can xu ly (Vi du: 202603 hoac 202604).\nDe trong va nhan OK neu muon chay cho TOAN BO ky:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    const input = response.getResponseText().trim();
    return input !== "" ? input : null;
  }
  return false;
}
