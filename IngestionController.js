/**
 * [CONTROLLER] IngestController - Quản lý kéo dữ liệu đa nguồn (PO, SO, OPENING...) từ Spoke về Hub RAW
 */
class IngestController {
  constructor() {
    this.tableRepo = new TableRepository();
    this.schemaService = new SchemaService(this.tableRepo);
    this.sysConfigService = new SysConfigService(this.tableRepo);
  }

  /**
   * Kéo dữ liệu từ Spoke về Bảng RAW dựa trên vị trí cột
   * @param {string} sourceGroup - Mã nguồn (VD: "PO", "SO", "OPENING", "INVENTORY_ADJUSTMENT")
   * @param {Array<string>} [periods=[]] - Danh sách kỳ cần lọc
   */
  runIngestion(sourceGroup, periods = []) {
    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup);

    if (!srcMeta.spokeFileId) {
      throw new Error(`[Ingestion Error] Nguồn [${sourceGroup}] chưa khai báo 'spoke.fileId' trong system_config.`);
    }

    Logger.log(`[INGESTION] Mở File Spoke ID: ${srcMeta.spokeFileId} | Sheet: ${srcMeta.spokeSheetName}`);

    // 1. Mở File & Sheet Spoke
    const spokeSpreadsheet = SpreadsheetApp.openById(srcMeta.spokeFileId);
    const spokeSheet = spokeSpreadsheet.getSheetByName(srcMeta.spokeSheetName);

    if (!spokeSheet) {
      throw new Error(`[Ingestion Error] Không tìm thấy sheet '${srcMeta.spokeSheetName}' tại Spoke ID: ${srcMeta.spokeFileId}`);
    }

    const spokeValues = spokeSheet.getDataRange().getValues();
    if (spokeValues.length <= 1) {
      Logger.log(`[WARNING] File Spoke [${sourceGroup}] không có dữ liệu.`);
      return 0;
    }

    // Xác định dòng dữ liệu (Bỏ qua dòng tiêu đề)
    const rawDataRows = spokeValues.slice(1);

    // 2. Lấy cấu hình Schema của Bảng RAW
    const rawSchemaConfig = this.schemaService.getSchemaMap()[srcMeta.rawSchema.toUpperCase()];
    if (!rawSchemaConfig) {
      throw new Error(`[Ingestion Error] Bảng RAW '${srcMeta.rawSchema}' chưa được định nghĩa trong SCHEMA.`);
    }

    const rawCols = rawSchemaConfig.columns;
    const sortedRawKeys = Object.keys(rawCols).sort((a, b) => rawCols[a] - rawCols[b]);
    const periodSchemaIdx = rawCols["period"] ? rawCols["period"] - 1 : -1;

    // 3. Lọc dữ liệu theo Kỳ (Period)
    const filteredRows = rawDataRows.filter(row => {
      if (periods && periods.length > 0 && periodSchemaIdx !== -1) {
        const rowPeriod = String(row[periodSchemaIdx] || "").trim();
        return periods.includes(rowPeriod);
      }
      return true;
    });

    if (filteredRows.length === 0) {
      Logger.log(`[WARNING] Không có dòng dữ liệu nào khớp với kỳ [${periods.join(", ")}].`);
      return 0;
    }

    // 4. Map dữ liệu Spoke sang RAW theo VỊ TRÍ CỘT
    const finalRawRows = filteredRows.map(spokeRow => {
      return sortedRawKeys.map((_, colIndex) => {
        const cellValue = spokeRow[colIndex];
        return cellValue !== undefined && cellValue !== null ? cellValue : "";
      });
    });

    // 5. Xác định Primary Keys chuẩn để Upsert vào Bảng RAW
    let targetKeys = rawSchemaConfig.primaryKeys || ["period", "invoice_code", "line_no"];
    const validKeys = targetKeys.filter(k => rawCols[k] !== undefined);
    if (validKeys.length === 0) {
      targetKeys = sortedRawKeys.slice(0, 3);
    } else {
      targetKeys = validKeys;
    }

    Logger.log(`[DEBUG INGESTION] Positional Mapping ${sortedRawKeys.length} cột | Primary Keys: [${targetKeys.join(", ")}]`);

    // 6. Upsert vào Bảng RAW
    this.tableRepo.upsertRowsByTableName(srcMeta.rawSchema, finalRawRows, targetKeys);
    Logger.log(`[INGESTION SUCCESS] Đã đồng bộ thành công ${finalRawRows.length} dòng vào [${srcMeta.rawSchema}].`);

    return finalRawRows.length;
  }
}
