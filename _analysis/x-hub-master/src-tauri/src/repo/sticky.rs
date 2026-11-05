use crate::models::Sticky;
use crate::repo::now;
use rusqlite::{params, Connection, Result};

pub fn list(conn: &Connection) -> Result<Vec<Sticky>> {
    let mut stmt = conn.prepare(
        "SELECT id, slot, content, version, created_at, updated_at FROM stickies ORDER BY slot ASC",
    )?;
    let rows = stmt.query_map([], row_to_sticky)?;
    rows.collect()
}

pub fn get_by_slot(conn: &Connection, slot: i64) -> Result<Option<Sticky>> {
    let mut stmt = conn.prepare(
        "SELECT id, slot, content, version, created_at, updated_at FROM stickies WHERE slot = ?1",
    )?;
    let mut rows = stmt.query_map(params![slot], row_to_sticky)?;
    rows.next().transpose()
}

pub fn upsert(conn: &Connection, slot: i64, content: &str) -> Result<Sticky> {
    conn.execute(
        "INSERT INTO stickies (slot, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(slot) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, version = stickies.version + 1",
        params![slot, content, now()],
    )?;
    get_by_slot(conn, slot)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// 乐观锁保存便签（局域网同步写回）：单条 UPSERT——记录存在时仅当 version == expected_version
///（expected 为 None 不校验）才更新并 +1，不命中则整条跳过（affected == 0 → CONFLICT）；
/// slot 无记录时直接插入（无需版本校验，version 从 0 起算——expected 提供但无记录也建档，
/// 同步端首次写回即建档）。
pub fn upsert_with_version(
    conn: &Connection,
    slot: i64,
    content: &str,
    expected_version: Option<i64>,
) -> Result<Sticky, String> {
    let affected = conn
        .execute(
            "INSERT INTO stickies (slot, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(slot) DO UPDATE SET
               content = excluded.content,
               updated_at = excluded.updated_at,
               version = stickies.version + 1
             WHERE ?4 IS NULL OR stickies.version = ?4",
            params![slot, content, now(), expected_version],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err(format!("CONFLICT: 便签 slot {slot} 已被他人修改，请刷新后重试"));
    }
    get_by_slot(conn, slot)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "INTERNAL: 便签保存后读取失败".to_string())
}

pub fn row_to_sticky(row: &rusqlite::Row) -> Result<Sticky> {
    Ok(Sticky {
        id: row.get(0)?,
        slot: row.get(1)?,
        content: row.get(2)?,
        version: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_in_memory;

    fn setup() -> Connection {
        init_in_memory().unwrap()
    }

    #[test]
    fn upsert_inserts_then_updates_same_slot() {
        let conn = setup();
        let first = upsert(&conn, 1, "第一条便签").unwrap();
        assert_eq!(first.slot, 1);
        assert_eq!(first.content, "第一条便签");
        let updated = upsert(&conn, 1, "改过了").unwrap();
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.content, "改过了");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn slots_are_independent() {
        let conn = setup();
        upsert(&conn, 1, "卡一").unwrap();
        upsert(&conn, 2, "卡二").unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(get_by_slot(&conn, 1).unwrap().unwrap().content, "卡一");
        assert_eq!(get_by_slot(&conn, 2).unwrap().unwrap().content, "卡二");
    }

    #[test]
    fn empty_list_on_fresh_db() {
        let conn = setup();
        assert!(list(&conn).unwrap().is_empty());
        assert!(get_by_slot(&conn, 1).unwrap().is_none());
    }

    #[test]
    fn upsert_with_version_optimistic_lock() {
        let conn = setup();
        upsert(&conn, 1, "原始内容").unwrap();
        assert_eq!(get_by_slot(&conn, 1).unwrap().unwrap().version, 0);

        // 版本命中：更新并自增 version
        let updated = upsert_with_version(&conn, 1, "第一次改", Some(0)).unwrap();
        assert_eq!(updated.content, "第一次改");
        assert_eq!(updated.version, 1);

        // 版本不匹配：CONFLICT，内容不被覆盖
        let err = upsert_with_version(&conn, 1, "冲突写入", Some(0)).unwrap_err();
        assert!(err.starts_with("CONFLICT"));
        let s = get_by_slot(&conn, 1).unwrap().unwrap();
        assert_eq!(s.content, "第一次改");
        assert_eq!(s.version, 1);

        // 不校验（None）等价普通更新
        let local = upsert_with_version(&conn, 1, "本地直写", None).unwrap();
        assert_eq!(local.content, "本地直写");
        assert_eq!(local.version, 2);
    }

    #[test]
    fn upsert_with_version_inserts_new_slot_without_guard() {
        // 空 slot：无需版本校验，直接插入 version=0
        let conn = setup();
        let created = upsert_with_version(&conn, 2, "新便签", None).unwrap();
        assert_eq!(created.slot, 2);
        assert_eq!(created.version, 0);
    }

    #[test]
    fn local_ui_upsert_bumps_version() {
        // 主 UI 便签保存（旧 upsert，600ms 防抖高频写）也必须推进版本链
        let conn = setup();
        let first = upsert(&conn, 1, "第一版").unwrap();
        assert_eq!(first.version, 0);
        let second = upsert(&conn, 1, "第二版").unwrap();
        assert_eq!(second.version, 1);
    }
}
