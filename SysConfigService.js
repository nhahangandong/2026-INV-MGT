/**
 * [CLASS] SysConfigService - Quan ly va tra cuu tham so cau hinh he thong
 */
class SysConfigService {
  constructor(tableRepo) {
    this.tableRepo = tableRepo;
    this.configMap = this._loadConfigs();
  }

  _loadConfigs() {
    try {
      // Su dung dung chuan schema_name viet hoa cua he thong V2
      const rawData = this.tableRepo.getDataByTableName("SYSTEM_CONFIG");
      const configMap = {};
      
      const values = rawData.values || rawData; // Tuong thich ca dang object metadata hoac mang 2 chieu
      if (values && values.length > 1) {
        const rows = values.slice(1);
        rows.forEach(row => {
          const key = row[0] ? String(row[0]).trim() : "";
          const value = row[1] ? String(row[1]).trim() : "";
          if (key) {
            configMap[key] = value;
          }
        });
      }
      return configMap;
    } catch (error) {
      Logger.log(`[ERROR] Khong the tai cau hinh tu he thong: ${error.message}`);
      return {};
    }
  }

  getConfig(key) {
    return this.configMap[key] || null;
  }
}