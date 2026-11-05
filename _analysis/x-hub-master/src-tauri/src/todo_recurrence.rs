//! 周期待办规则引擎（**规则的唯一实现**）。
//!
//! 滚动（§5.1）与日历虚拟展开（§5.4）共用本模块：前端只消费
//! `expand_todo_occurrences` 命令的返回结果渲染，不重写规则——规则只存在一份，
//! 从根上不存在「两端漂移」。
//!
//! 时间语义与前端一致：毫秒时间戳按**本地时区**落到「日」，重复时保留首次排期的
//! 时分（§5.1 滚动只推日期）。

use crate::models::RepeatRule;
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveTime, TimeZone, Weekday};

/// 迭代上限：规则异常时防死循环（§5.1）。
///
/// 取值要覆盖「逾期很久后点完成」与「日历翻到很远的月份」两种快进场景：
/// daily 规则 10 万次 ≈ 273 年，weekly ≈ 1900 年，monthly 更远。
/// 上限用尽与「规则自然结束」必须区分——前者是计算失败（返回 Err），
/// 后者才是 None；混为一谈会把还在生效的周期静默降级成一次性待办。
pub const MAX_ITER: usize = 100_000;

/// 迭代预算耗尽（规则没有在预算内推进到目标区间）。
const ERR_ITER_LIMIT: &str =
    "RECURRENCE_ITER_LIMIT: 周期规则在迭代预算内没有推进到目标时刻（规则或截止时刻异常）";

/// 单次展开区间的上限（天）。区间越长迭代越多，而展开全程**持着数据库互斥锁**：
/// 扩展传「今天 → 100 年后」时，一条「每天」的待办就要迭代 3.65 万次，主界面这段时间
/// 点什么都像卡死。宿主日历只查 42 天，正常用碰不到；超限直接报错，要求调用方分段查。
pub const MAX_RANGE_DAYS: i64 = 366;

const ERR_RANGE_LIMIT: &str = "RECURRENCE_RANGE_TOO_LARGE: 展开区间过大，请分段查询（上限 {} 天）";

/// 校验展开区间。`to < from` 是空区间，交给 `expand_occurrences` 返回空列表；
/// 这里只拦「跨度过大」，`i64` 极值用 saturating 运算避免溢出。
pub fn validate_range(from_ms: i64, to_ms: i64) -> Result<(), String> {
    if to_ms <= from_ms {
        return Ok(());
    }
    if to_ms.saturating_sub(from_ms) / 86_400_000 > MAX_RANGE_DAYS {
        return Err(ERR_RANGE_LIMIT.replace("{}", &MAX_RANGE_DAYS.to_string()));
    }
    Ok(())
}

/// 位掩码 bit0=周一 … bit6=周日
fn mask_has(mask: i64, wd: Weekday) -> bool {
    mask & (1 << wd.num_days_from_monday()) != 0
}

fn weekday_offsets(mask: i64) -> Vec<u32> {
    (0..7u32).filter(|i| mask & (1 << i) != 0).collect()
}

/// 本地「日 + 时分」→ 毫秒时间戳。
/// 夏令时歧义取较早的一侧；**不存在的时刻（春季跳变被跳过的那一小时）顺延到当日
/// 第一个有效时刻**——绝不能返回 None：上层把 None 当成「规则已用尽」，
/// 会让「每天 02:30」这类待办在跳变日点完成时被静默取消周期。
fn at_time(date: NaiveDate, time: NaiveTime) -> Option<i64> {
    use chrono::LocalResult;
    let naive = date.and_time(time);
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp_millis()),
        LocalResult::None => {
            for min in 1..=180i64 {
                match Local.from_local_datetime(&(naive + Duration::minutes(min))) {
                    LocalResult::Single(dt) => return Some(dt.timestamp_millis()),
                    LocalResult::Ambiguous(earliest, _) => return Some(earliest.timestamp_millis()),
                    LocalResult::None => continue,
                }
            }
            None
        }
    }
}

fn weekday_from_index(i: u32) -> Weekday {
    match i {
        0 => Weekday::Mon,
        1 => Weekday::Tue,
        2 => Weekday::Wed,
        3 => Weekday::Thu,
        4 => Weekday::Fri,
        5 => Weekday::Sat,
        _ => Weekday::Sun,
    }
}

/// 取某月最后一天
fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

/// 某月第 n 个（n = 1..5；-1 = 最后一个）指定星期几
fn nth_weekday_of_month(year: i32, month: u32, weekday: Weekday, nth: i64) -> Option<NaiveDate> {
    if nth == -1 {
        let last = last_day_of_month(year, month);
        let d = NaiveDate::from_ymd_opt(year, month, last)?;
        let back = (d.weekday().num_days_from_monday() as i64
            - weekday.num_days_from_monday() as i64)
            .rem_euclid(7);
        return d.checked_sub_signed(Duration::days(back));
    }
    if nth < 1 {
        return None;
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let fwd = (weekday.num_days_from_monday() as i64
        - first.weekday().num_days_from_monday() as i64)
        .rem_euclid(7)
        + (nth - 1) * 7;
    let day = 1 + fwd as u32;
    if day > last_day_of_month(year, month) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, day)
}

fn month_anchor(year: i32, month: u32, rule: &RepeatRule) -> Option<NaiveDate> {
    match (rule.month_nth, rule.month_day) {
        (Some(nth), _) => {
            let mask = rule.weekdays.unwrap_or(0);
            let offsets = weekday_offsets(mask);
            let wd = weekday_from_index(*offsets.first()?);
            nth_weekday_of_month(year, month, wd, nth)
        }
        (None, Some(day)) => {
            let d = if day == -1 {
                last_day_of_month(year, month)
            } else {
                (day.max(1) as u32).min(last_day_of_month(year, month))
            };
            NaiveDate::from_ymd_opt(year, month, d)
        }
        _ => None,
    }
}

/// 某时刻所在「周」的周一（仅用于 custom+week 的周计数）。
/// 周差必须按**日历日**算，不能用毫秒差除以 7 天：跨夏令时切换的那一周只有 167 小时，
/// 整除后周序号少 1，「每 2 周的周一」会整周漏掉（中国无夏令时，但用户可能在别的时区）。
fn week_monday(ms: i64) -> Option<NaiveDate> {
    let dt = Local.timestamp_millis_opt(ms).single()?;
    dt.date_naive()
        .checked_sub_signed(Duration::days(dt.weekday().num_days_from_monday() as i64))
}

/// 下一个实例（严格晚于 prev）。规则用尽（如 monthly 无合法日）返回 None。
fn advance(rule: &RepeatRule, prev: i64, base_time: NaiveTime) -> Option<i64> {
    let dt = Local.timestamp_millis_opt(prev).single()?;
    let date = dt.date_naive();
    match rule.mode.as_str() {
        "daily" => at_time(date + Duration::days(1), base_time),
        "weekdays" => {
            let mut d = date + Duration::days(1);
            for _ in 0..7 {
                if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                    return at_time(d, base_time);
                }
                d += Duration::days(1);
            }
            None
        }
        "weekly" => {
            let mask = rule.weekdays.unwrap_or(0);
            if mask == 0 {
                return at_time(date + Duration::days(7), base_time);
            }
            let mut d = date + Duration::days(1);
            for _ in 0..7 {
                if mask_has(mask, d.weekday()) {
                    return at_time(d, base_time);
                }
                d += Duration::days(1);
            }
            None
        }
        "monthly" => {
            let (ny, nm) = if date.month() == 12 {
                (date.year() + 1, 1)
            } else {
                (date.year(), date.month() + 1)
            };
            month_anchor(ny, nm, rule).and_then(|d| at_time(d, base_time))
        }
        "yearly" => {
            let y = date.year() + 1;
            let m = date.month();
            let day = date.day().min(last_day_of_month(y, m));
            NaiveDate::from_ymd_opt(y, m, day).and_then(|d| at_time(d, base_time))
        }
        "custom" => {
            let every = rule.every.unwrap_or(1).max(1);
            match rule.unit.as_deref().unwrap_or("day") {
                "week" => {
                    let mask = rule.weekdays.unwrap_or(0);
                    if mask == 0 {
                        return at_time(date + Duration::weeks(every), base_time);
                    }
                    // 位掩码 + 每 N 周：逐日找掩码内的星期几，且周序号差是 N 的倍数
                    let base_week = week_monday(prev)?;
                    let mut d = date + Duration::days(1);
                    for _ in 0..(every * 7) {
                        if mask_has(mask, d.weekday()) {
                            if let Some(ms) = at_time(d, base_time) {
                                let ws = week_monday(ms)?;
                                let weeks = (ws - base_week).num_days() / 7;
                                if weeks.rem_euclid(every) == 0 {
                                    return Some(ms);
                                }
                            }
                        }
                        d += Duration::days(1);
                    }
                    None
                }
                "month" => {
                    let total = date.year() * 12 + (date.month() as i32 - 1) + every as i32;
                    let (ny, nm) = (total.div_euclid(12), (total.rem_euclid(12) + 1) as u32);
                    let day = date.day().min(last_day_of_month(ny, nm));
                    NaiveDate::from_ymd_opt(ny, nm, day).and_then(|d| at_time(d, base_time))
                }
                "year" => {
                    let y = date.year() + every as i32;
                    let m = date.month();
                    let day = date.day().min(last_day_of_month(y, m));
                    NaiveDate::from_ymd_opt(y, m, day).and_then(|d| at_time(d, base_time))
                }
                _ => at_time(date + Duration::days(every), base_time),
            }
        }
        _ => None,
    }
}

/// 上一个实例（严格早于 cur），用于撤销勾选时把 due_at 滚回本轮。
fn retreat(rule: &RepeatRule, cur: i64, base_time: NaiveTime) -> Option<i64> {
    let dt = Local.timestamp_millis_opt(cur).single()?;
    let date = dt.date_naive();
    match rule.mode.as_str() {
        "daily" => at_time(date - Duration::days(1), base_time),
        "weekdays" => {
            let mut d = date - Duration::days(1);
            for _ in 0..7 {
                if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                    return at_time(d, base_time);
                }
                d -= Duration::days(1);
            }
            None
        }
        "weekly" => {
            let mask = rule.weekdays.unwrap_or(0);
            if mask == 0 {
                return at_time(date - Duration::days(7), base_time);
            }
            let mut d = date - Duration::days(1);
            for _ in 0..7 {
                if mask_has(mask, d.weekday()) {
                    return at_time(d, base_time);
                }
                d -= Duration::days(1);
            }
            None
        }
        "monthly" => {
            let (py, pm) = if date.month() == 1 {
                (date.year() - 1, 12)
            } else {
                (date.year(), date.month() - 1)
            };
            month_anchor(py, pm, rule).and_then(|d| at_time(d, base_time))
        }
        "yearly" => {
            let y = date.year() - 1;
            let m = date.month();
            let day = date.day().min(last_day_of_month(y, m));
            NaiveDate::from_ymd_opt(y, m, day).and_then(|d| at_time(d, base_time))
        }
        "custom" => {
            let every = rule.every.unwrap_or(1).max(1);
            match rule.unit.as_deref().unwrap_or("day") {
                "week" => {
                    let mask = rule.weekdays.unwrap_or(0);
                    if mask == 0 {
                        return at_time(date - Duration::weeks(every), base_time);
                    }
                    let base_week = week_monday(cur)?;
                    let mut d = date - Duration::days(1);
                    for _ in 0..(every * 7) {
                        if mask_has(mask, d.weekday()) {
                            if let Some(ms) = at_time(d, base_time) {
                                let ws = week_monday(ms)?;
                                let weeks = (base_week - ws).num_days() / 7;
                                if weeks.rem_euclid(every) == 0 {
                                    return Some(ms);
                                }
                            }
                        }
                        d -= Duration::days(1);
                    }
                    None
                }
                "month" => {
                    let total = date.year() * 12 + (date.month() as i32 - 1) - every as i32;
                    let (py, pm) = (total.div_euclid(12), (total.rem_euclid(12) + 1) as u32);
                    let day = date.day().min(last_day_of_month(py, pm));
                    NaiveDate::from_ymd_opt(py, pm, day).and_then(|d| at_time(d, base_time))
                }
                "year" => {
                    let y = date.year() - every as i32;
                    let m = date.month();
                    let day = date.day().min(last_day_of_month(y, m));
                    NaiveDate::from_ymd_opt(y, m, day).and_then(|d| at_time(d, base_time))
                }
                _ => at_time(date - Duration::days(every), base_time),
            }
        }
        _ => None,
    }
}

/// 从 due_at 起算、**严格晚于 from_ms** 的第一个实例时刻（§5.1 滚动用）。
/// 逾期不补历史：连续迭代直到落在 from_ms 之后。
/// `Ok(None)` = 规则已用尽（until 越界 / 锚点算不出）；`Err` = 迭代预算耗尽
/// （计算失败，调用方**不能**当成「周期结束」，否则会静默把周期降级成一次性）。
pub fn next_occurrence(rule: &RepeatRule, due_at: i64, from_ms: i64) -> Result<Option<i64>, String> {
    if rule.is_once() {
        return Ok(None);
    }
    let base_time = Local
        .timestamp_millis_opt(due_at)
        .single()
        .ok_or_else(|| "RECURRENCE_INVALID_TIME: due_at 不是合法时间戳".to_string())?
        .time();
    let mut prev = due_at;
    for _ in 0..MAX_ITER {
        let Some(next) = advance(rule, prev, base_time) else {
            return Ok(None);
        };
        if !within_end(rule, next) {
            return Ok(None);
        }
        if next > from_ms {
            return Ok(Some(next));
        }
        prev = next;
    }
    Err(ERR_ITER_LIMIT.to_string())
}

/// 撤销用：严格早于 cur 的实例时刻
pub fn previous_occurrence(rule: &RepeatRule, cur: i64) -> Option<i64> {
    if rule.is_once() {
        return None;
    }
    let base_time = Local.timestamp_millis_opt(cur).single()?.time();
    retreat(rule, cur, base_time)
}

/// 结束条件（until）：超出截止日即结束。count 由调用方按剩余次数截断。
fn within_end(rule: &RepeatRule, at_ms: i64) -> bool {
    match rule.end_mode.as_deref() {
        Some("until") => rule.end_at.map(|end| at_ms <= end).unwrap_or(true),
        _ => true,
    }
}

/// 结束条件是否已用尽（滚动到 next 之前判断，§5.3）
pub fn reached_end(rule: &RepeatRule, next: i64, done_count: i64) -> bool {
    if !within_end(rule, next) {
        return true;
    }
    match rule.end_mode.as_deref() {
        Some("count") => match rule.count {
            Some(total) => done_count + 1 >= total,
            None => false,
        },
        _ => false,
    }
}

/// 展开 [from_ms, to_ms] 内的**虚拟实例**（不含库里那一行当前实例本身）。
/// count 结束条件按剩余次数截断——当前行是第 `done_count + 1` 个实例，
/// 所以未来还剩 `count - done_count - 1` 个（不是 `count - done_count`）。
/// `Err` = 迭代预算耗尽（历史区间过长）或区间超限，报错而不是返回残缺列表。
pub fn expand_occurrences(
    rule: &RepeatRule,
    due_at: i64,
    done_count: i64,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<i64>, String> {
    // 区间上限在这里兜底：无论宿主命令还是扩展桥，都不可能传一个超长区间进来
    validate_range(from_ms, to_ms)?;
    let mut out = Vec::new();
    if rule.is_once() || to_ms < from_ms {
        return Ok(out);
    }
    let base_time = Local
        .timestamp_millis_opt(due_at)
        .single()
        .ok_or_else(|| "RECURRENCE_INVALID_TIME: due_at 不是合法时间戳".to_string())?
        .time();
    let mut remaining = match rule.end_mode.as_deref() {
        Some("count") => match rule.count {
            Some(total) => (total - done_count - 1).max(0),
            None => i64::MAX,
        },
        _ => i64::MAX,
    };
    let mut prev = due_at;
    for _ in 0..MAX_ITER {
        let Some(next) = advance(rule, prev, base_time) else {
            return Ok(out);
        };
        if !within_end(rule, next) || next > to_ms {
            return Ok(out);
        }
        if next >= from_ms {
            if remaining <= 0 {
                return Ok(out);
            }
            out.push(next);
            remaining -= 1;
        }
        prev = next;
    }
    Err(ERR_ITER_LIMIT.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        at_time(
            NaiveDate::from_ymd_opt(y, mo, d).unwrap(),
            NaiveTime::from_hms_opt(h, mi, 0).unwrap(),
        )
        .unwrap()
    }

    fn rule(mode: &str) -> RepeatRule {
        RepeatRule {
            mode: mode.to_string(),
            every: None,
            unit: None,
            weekdays: None,
            month_day: None,
            month_nth: None,
            end_mode: None,
            end_at: None,
            count: None,
        }
    }

    /// 测试用薄封装：预算耗尽在测试里就是失败，直接 unwrap 成 Option
    fn next_at(rule: &RepeatRule, due: i64, from: i64) -> Option<i64> {
        next_occurrence(rule, due, from).unwrap()
    }

    fn expand_at(rule: &RepeatRule, due: i64, done: i64, from: i64, to: i64) -> Vec<i64> {
        expand_occurrences(rule, due, done, from, to).unwrap()
    }

    /// 区间上限：超限报错而不是傻算；边界值（正好 366 天）放行
    #[test]
    fn validate_range_rejects_over_limit() {
        let day = 86_400_000i64;
        let from = ts(2026, 1, 1, 0, 0);
        assert!(validate_range(from, from + MAX_RANGE_DAYS * day).is_ok());
        let err = validate_range(from, from + (MAX_RANGE_DAYS + 1) * day).unwrap_err();
        assert!(err.starts_with("RECURRENCE_RANGE_TOO_LARGE"), "{err}");
        // 100 年区间：正是扩展最容易传的那种
        assert!(validate_range(from, from + 36_500 * day).is_err());
        // 空区间 / 逆序区间不算超限，交给展开逻辑返回空列表
        assert!(validate_range(from, from).is_ok());
        assert!(validate_range(from, from - day).is_ok());
        // i64 极值不 panic（saturating）
        assert!(validate_range(i64::MIN, i64::MAX).is_err());
    }

    /// 超长区间必须在引擎层就被拒绝（宿主命令与扩展桥都走这里）
    #[test]
    fn expand_occurrences_rejects_huge_range() {
        let due = ts(2026, 9, 21, 9, 0);
        let r = rule("daily");
        let err = expand_occurrences(&r, due, 0, due, due + 100 * 365 * 86_400_000).unwrap_err();
        assert!(err.starts_with("RECURRENCE_RANGE_TOO_LARGE"), "{err}");
    }

    #[test]
    fn daily_keeps_time_of_day() {
        let due = ts(2026, 9, 21, 9, 30);
        let r = rule("daily");
        let next = next_at(&r, due, due).unwrap();
        assert_eq!(next, ts(2026, 9, 22, 9, 30));
    }

    #[test]
    fn daily_skips_missed_periods() {
        // 逾期 3 天不补历史：直接滚到最近一个未来时刻
        let due = ts(2026, 9, 21, 9, 0);
        let now = ts(2026, 9, 24, 10, 0);
        let r = rule("daily");
        assert_eq!(next_at(&r, due, now).unwrap(), ts(2026, 9, 25, 9, 0));
    }

    #[test]
    fn weekdays_skip_weekend() {
        // 2026-09-25 是周五 → 下一轮周一 09-28
        let due = ts(2026, 9, 25, 9, 0);
        let r = rule("weekdays");
        assert_eq!(next_at(&r, due, due).unwrap(), ts(2026, 9, 28, 9, 0));
    }

    #[test]
    fn weekly_with_mask_picks_selected_days() {
        // 周一 + 周三（bit0 + bit2）
        let mut r = rule("weekly");
        r.weekdays = Some(0b0000101);
        let due = ts(2026, 9, 21, 8, 0); // 周一
        let next = next_at(&r, due, due).unwrap();
        assert_eq!(next, ts(2026, 9, 23, 8, 0)); // 周三
        let next2 = next_at(&r, next, next).unwrap();
        assert_eq!(next2, ts(2026, 9, 28, 8, 0)); // 下周一
    }

    #[test]
    fn monthly_clamps_to_month_end() {
        // 每月 31 号：2 月取 28 号（2027 非闰年）
        let mut r = rule("monthly");
        r.month_day = Some(31);
        let due = ts(2027, 1, 31, 9, 0);
        assert_eq!(next_at(&r, due, due).unwrap(), ts(2027, 2, 28, 9, 0));
    }

    #[test]
    fn monthly_last_day_uses_actual_month_end() {
        let mut r = rule("monthly");
        r.month_day = Some(-1);
        let due = ts(2027, 1, 31, 9, 0);
        assert_eq!(next_at(&r, due, due).unwrap(), ts(2027, 2, 28, 9, 0));
    }

    #[test]
    fn monthly_nth_weekday() {
        // 每月第 2 个星期一
        let mut r = rule("monthly");
        r.month_nth = Some(2);
        r.weekdays = Some(1 << 0);
        let due = ts(2026, 9, 14, 9, 0); // 9 月第 2 个周一
        assert_eq!(next_at(&r, due, due).unwrap(), ts(2026, 10, 12, 9, 0));
    }

    #[test]
    fn yearly_keeps_month_day() {
        let r = rule("yearly");
        let due = ts(2026, 3, 15, 10, 0);
        assert_eq!(next_at(&r, due, due).unwrap(), ts(2027, 3, 15, 10, 0));
    }

    #[test]
    fn custom_every_n_days() {
        let mut r = rule("custom");
        r.every = Some(3);
        r.unit = Some("day".into());
        let due = ts(2026, 9, 21, 9, 0);
        assert_eq!(next_at(&r, due, due).unwrap(), ts(2026, 9, 24, 9, 0));
    }

    /// custom + week + 掩码：周序号差必须按日历周算（每 N 周只在第 N 周的星期几出现），
    /// 用毫秒差除以 7 天会在跨夏令时的周少数一周、整周漏掉。
    #[test]
    fn custom_every_n_weeks_with_mask() {
        let mut r = rule("custom");
        r.every = Some(2);
        r.unit = Some("week".into());
        r.weekdays = Some(0b0000101); // 周一 + 周三
        let due = ts(2026, 9, 21, 8, 0); // 周一
        let wed = next_at(&r, due, due).unwrap();
        assert_eq!(wed, ts(2026, 9, 23, 8, 0)); // 同一周的周三
        let mon = next_at(&r, wed, wed).unwrap();
        assert_eq!(mon, ts(2026, 10, 5, 8, 0)); // 隔一周后的周一
        let wed2 = next_at(&r, mon, mon).unwrap();
        assert_eq!(wed2, ts(2026, 10, 7, 8, 0));
        // 撤销：严格回到上一轮
        assert_eq!(previous_occurrence(&r, mon).unwrap(), ts(2026, 9, 23, 8, 0));
        assert_eq!(previous_occurrence(&r, wed).unwrap(), ts(2026, 9, 21, 8, 0));
    }

    #[test]
    fn until_end_stops_expansion() {
        let mut r = rule("daily");
        r.end_mode = Some("until".into());
        r.end_at = Some(ts(2026, 9, 23, 23, 59));
        let due = ts(2026, 9, 21, 9, 0);
        assert_eq!(next_at(&r, due, due).unwrap(), ts(2026, 9, 22, 9, 0));
        let beyond = ts(2026, 9, 23, 9, 0);
        assert!(next_occurrence(&r, beyond, beyond).unwrap().is_none());
    }

    #[test]
    fn count_end_truncates_expansion() {
        let mut r = rule("daily");
        r.end_mode = Some("count".into());
        r.count = Some(3);
        let due = ts(2026, 9, 21, 9, 0);
        // 一次都没做过：库里的 09-21 是第 1 个实例，未来只剩第 2、3 个（共 3 次）
        let got = expand_at(&r, due, 0, due, ts(2026, 10, 10, 0, 0));
        assert_eq!(got, vec![ts(2026, 9, 22, 9, 0), ts(2026, 9, 23, 9, 0)]);

        // 已做 1 次（due 已滚到 09-22，即第 2 个实例）→ 未来只剩 1 个
        let rolled = ts(2026, 9, 22, 9, 0);
        let got = expand_at(&r, rolled, 1, rolled, ts(2026, 10, 10, 0, 0));
        assert_eq!(got, vec![ts(2026, 9, 23, 9, 0)]);
    }

    /// 逾期很久后点完成 / 日历翻到远期：迭代预算必须够用，
    /// 且预算真的用尽时要报错，不能当成「周期结束」（那会静默转一次性）。
    #[test]
    fn far_future_and_long_overdue_still_resolve() {
        let r = rule("daily");
        let due = ts(2026, 9, 21, 9, 0);
        // 逾期 5 年后点完成：应滚到最近一个未来时刻
        let now = ts(2031, 9, 21, 10, 0);
        assert_eq!(next_at(&r, due, now).unwrap(), ts(2031, 9, 22, 9, 0));
        // 日历翻到 5 年后：区间内实例照常展开（不再因迭代预算耗尽而整段漏掉）
        let got = expand_at(&r, due, 0, ts(2031, 9, 21, 0, 0), ts(2031, 9, 24, 23, 59));
        assert_eq!(
            got,
            vec![
                ts(2031, 9, 21, 9, 0),
                ts(2031, 9, 22, 9, 0),
                ts(2031, 9, 23, 9, 0),
                ts(2031, 9, 24, 9, 0),
            ]
        );
    }

    #[test]
    fn expand_lists_virtual_occurrences_in_range() {
        let r = rule("daily");
        let due = ts(2026, 9, 21, 9, 0);
        let got = expand_at(&r, due, 0, ts(2026, 9, 22, 0, 0), ts(2026, 9, 25, 23, 59));
        assert_eq!(
            got,
            vec![
                ts(2026, 9, 22, 9, 0),
                ts(2026, 9, 23, 9, 0),
                ts(2026, 9, 24, 9, 0),
                ts(2026, 9, 25, 9, 0),
            ]
        );
    }

    #[test]
    fn previous_occurrence_rolls_back() {
        let r = rule("daily");
        let cur = ts(2026, 9, 22, 9, 0);
        assert_eq!(previous_occurrence(&r, cur).unwrap(), ts(2026, 9, 21, 9, 0));
    }

    #[test]
    fn weekly_mask_previous_occurrence() {
        let mut r = rule("weekly");
        r.weekdays = Some(0b0000101); // 周一 + 周三
        let cur = ts(2026, 9, 23, 8, 0); // 周三
        assert_eq!(previous_occurrence(&r, cur).unwrap(), ts(2026, 9, 21, 8, 0)); // 周一
    }

    #[test]
    fn once_has_no_occurrences() {
        let r = rule("once");
        let due = ts(2026, 9, 21, 9, 0);
        assert!(next_occurrence(&r, due, due).unwrap().is_none());
        assert!(expand_at(&r, due, 0, due, due + 1).is_empty());
    }

    /// 规则列范围校验：这些非法值在引擎里会静默改变语义（周期被当成已用尽）
    /// 或让 chrono 溢出 panic，必须 fail-fast 而不是放行。
    #[test]
    fn validate_rejects_out_of_range_rule_columns() {
        // monthNth=0：既不是 1..5 也不是 -1，month_anchor 会返回 None → 规则静默用尽
        let mut r = rule("monthly");
        r.month_nth = Some(0);
        r.weekdays = Some(1);
        assert!(r.validate().is_err(), "monthNth=0 应被拒");

        // 「第几个星期几」缺 weekdays：取不到星期几，同样算不出锚点
        let mut r = rule("monthly");
        r.month_nth = Some(2);
        assert!(r.validate().is_err(), "monthly+nth 缺 weekdays 应被拒");

        // 越界掩码会被 weekday_from_index 兜底成周日
        let mut r = rule("weekly");
        r.weekdays = Some(1 << 40);
        assert!(r.validate().is_err(), "weekdays 越界应被拒");

        // 极大间隔会让 chrono::Duration::days 溢出 panic
        let mut r = rule("custom");
        r.every = Some(i64::MAX);
        r.unit = Some("day".into());
        assert!(r.validate().is_err(), "every 越界应被拒");

        // 合法边界（月末 / 最后一个星期几 / 上限内间隔）仍然通过
        let mut r = rule("monthly");
        r.month_day = Some(-1);
        assert!(r.validate().is_ok(), "monthDay=-1（月末）应通过");
        let mut r = rule("monthly");
        r.month_nth = Some(-1);
        r.weekdays = Some(1 << 6);
        assert!(r.validate().is_ok(), "monthNth=-1 + weekdays 应通过");
        let mut r = rule("custom");
        r.every = Some(999);
        r.unit = Some("day".into());
        assert!(r.validate().is_ok(), "every=999 应通过");
    }
}
