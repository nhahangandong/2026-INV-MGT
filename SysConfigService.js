/**
 * [SERVICE] SysConfigService - Quản lý và cung cấp cấu hình hệ thống
 */
class SysConfigService {
  /**
   * @param {Object} tableRepo - Repository thao tác dữ liệu bảng Hub
   */
  constructor(tableRepo) {
    if (!tableRepo) {
      throw new Error("[SysConfigService] Thiếu Dependency tableRepo.");
    }
    this.tableRepo = tableRepo;
    this._configCache = null;
  }

  /**
   * Nạp toàn bộ config vào Cache memory
   * @private
   */
  _loadConfigCache() {
    if (this._configCache) return;

    const dataInfo = this.tableRepo.getDataByTableName("system_config");
    this._configCache = new Map();

    if (!dataInfo || !dataInfo.values || dataInfo.values.length <= 1) return;

    const rows = dataInfo.values.slice(1);
    rows.forEach(row => {
      const key = row[0] ? String(row[0]).trim() : "";
      const val = row[1] ? String(row[1]).trim() : "";
      if (key) {
        this._configCache.set(key, val);
      }
    });
  }

  /**
   * Đọc giá trị raw string của 1 key
   */
  getConfig(key) {
    this._loadConfigCache();
    return this._configCache.get(key) || null;
  }

  /**
   * Đọc và parse JSON cấu hình nguồn (SRC_CFG_*) chuẩn hóa theo dạng Nested
   * @param {string} sourceGroup - Mã nguồn (VD: "PO", "SO", "OPENING", "INVENTORY_ADJUSTMENT")
   * @returns {Object} Normalized Metadata Object
   */
  getSourceMetadata(sourceGroup) {
    if (!sourceGroup) {
      throw new Error("[SysConfigService] Tham số 'sourceGroup' không được để trống.");
    }

    const normGrp = String(sourceGroup).toUpperCase().trim();
    const configKey = `SRC_CFG_${normGrp}`;
    const jsonStr = this.getConfig(configKey);

    if (!jsonStr) {
      throw new Error(`[SysConfigService Error] Không tìm thấy cấu hình '${configKey}' trong system_config.`);
    }

    let rawObj;
    try {
      rawObj = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`[SysConfigService Error] Cấu hình '${configKey}' sai cú pháp JSON: ${e.message}`);
    }

    // Mapper hỗ trợ fallback mượt mà nếu có key cũ lẫn mới
    const spoke = rawObj.spoke || {};
    const raw = rawObj.raw || {};
    const stg = rawObj.stg || {};
    const mapping = rawObj.mapping || {};

    const normalized = {
      sourceGroup: normGrp,
      spokeFileId: spoke.fileId || rawObj.spokeFileId || "",
      spokeSheetName: spoke.sheetName || rawObj.spokeSheetName || "Sheet1",
      rawSchema: raw.tableName || rawObj.rawSchema || "",
      stgSchema: stg.tableName || rawObj.stgSchema || "",
      primaryKeys: stg.primaryKeys || rawObj.primaryKeys || [],
      requiredFields: stg.requiredFields || rawObj.requiredFields || [],
      defaultItemType: stg.defaultItemType || rawObj.defaultItemType || "MERCHANDISE",
      coreGroup: mapping.coreGroup || rawObj.coreGroup || "INT",
      mapRuleGroup: mapping.mapRuleGroup || rawObj.mapRuleGroup || normGrp,
      factTable: mapping.factTable || rawObj.factTable || "",
      factPrimaryKeys: mapping.factPrimaryKeys || rawObj.factPrimaryKeys || [],
      columnMap: mapping.columnMap || rawObj.columnMap || {}
    };

    // Validation cơ bản
    if (!normalized.rawSchema || !normalized.stgSchema) {
      throw new Error(`[SysConfigService Error] '${configKey}' thiếu khai báo rawSchema hoặc stgSchema.`);
    }

    return normalized;
  }
}
