//! Spreadsheet export for the Marine comment ledger.
//!
//! The caller hands over rows that are already rendered — the same strings the
//! ledger table shows — and this module turns them into a workbook. The split
//! is deliberate: every label in the sheet is user-facing text that has to come
//! from the translation catalogue, which lives in the frontend, so the sheet
//! cannot be assembled here without either hard-coding English or duplicating
//! the catalogue. Formatting and the file format are this module's job.
//!
//! `.xlsx` rather than CSV, for two reasons that both bite this data set:
//! comment text carries newlines, commas and quotes that no two CSV readers
//! agree on, and a cell beginning `=`, `+`, `-` or `@` is a live formula in a
//! CSV opened by Excel. Scraped page titles are attacker-influenced, so that
//! second one is a real injection surface. String cells in a workbook are inert.

use rust_xlsxwriter::{Format, FormatAlign, Workbook, XlsxError};
use serde::Deserialize;
use std::path::Path;
use thiserror::Error;
use utoipa::ToSchema;

/// Excel refuses a longer cell and reports the whole file as corrupt.
const MAX_CELL_CHARS: usize = 32_767;

/// One less than Excel's 1,048,576-row ceiling, leaving room for the header.
const MAX_DATA_ROWS: usize = 1_048_575;

/// Column width is in character widths, not pixels. The floor keeps a narrow
/// header (`平台`) readable; the ceiling stops the comment column from being
/// hundreds of characters wide, which makes the sheet unusable on open.
const MIN_COLUMN_WIDTH: f64 = 10.0;
const MAX_COLUMN_WIDTH: f64 = 60.0;

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PostingHistoryExport {
  pub sheet_name: String,
  pub headers: Vec<String>,
  pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Error)]
pub enum ExportError {
  #[error("the export has no columns")]
  NoColumns,
  #[error("the export has no rows")]
  NoRows,
  #[error("row {row} has {actual} cells, expected {expected}")]
  RaggedRow {
    row: usize,
    actual: usize,
    expected: usize,
  },
  #[error("the export has {0} rows, more than one worksheet can hold")]
  TooManyRows(usize),
  #[error("failed to build the workbook: {0}")]
  Workbook(#[from] XlsxError),
}

/// Trim a cell to what Excel accepts, on a character boundary.
fn cell_text(value: &str) -> &str {
  match value.char_indices().nth(MAX_CELL_CHARS) {
    Some((end, _)) => &value[..end],
    None => value,
  }
}

/// A rough on-screen width for `text`, counting CJK as double-width.
///
/// The ledger is mostly Chinese, and treating those as one character each makes
/// every column open about half as wide as its contents need.
fn display_width(text: &str) -> f64 {
  text
    .chars()
    .map(|c| if (c as u32) >= 0x1100 { 2.0 } else { 1.0 })
    .sum()
}

/// Excel caps a sheet name at 31 characters and rejects `[]:*?/\`. A name that
/// breaks either rule fails the whole write, so a bad one is replaced rather
/// than propagated — the sheet name is decoration, the rows are the point.
fn sheet_name(requested: &str) -> String {
  let cleaned: String = requested
    .chars()
    .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
    .take(31)
    .collect();
  let cleaned = cleaned.trim().to_string();
  if cleaned.is_empty() {
    "Comments".to_string()
  } else {
    cleaned
  }
}

pub fn write_workbook(export: &PostingHistoryExport, path: &Path) -> Result<(), ExportError> {
  let columns = export.headers.len();
  if columns == 0 {
    return Err(ExportError::NoColumns);
  }
  if export.rows.is_empty() {
    return Err(ExportError::NoRows);
  }
  if export.rows.len() > MAX_DATA_ROWS {
    return Err(ExportError::TooManyRows(export.rows.len()));
  }
  for (index, row) in export.rows.iter().enumerate() {
    if row.len() != columns {
      return Err(ExportError::RaggedRow {
        row: index,
        actual: row.len(),
        expected: columns,
      });
    }
  }

  let mut workbook = Workbook::new();
  let worksheet = workbook.add_worksheet();
  worksheet.set_name(sheet_name(&export.sheet_name))?;

  let header_format = Format::new().set_bold();
  // Comments run long and contain newlines; without this every row renders as
  // one clipped line and the export is only good for machines.
  let body_format = Format::new().set_text_wrap().set_align(FormatAlign::Top);

  let mut widths = vec![MIN_COLUMN_WIDTH; columns];
  for (column, header) in export.headers.iter().enumerate() {
    worksheet.write_string_with_format(0, column as u16, cell_text(header), &header_format)?;
    widths[column] = widths[column].max(display_width(header) + 2.0);
  }

  for (index, row) in export.rows.iter().enumerate() {
    let row_number = (index + 1) as u32;
    for (column, value) in row.iter().enumerate() {
      let text = cell_text(value);
      worksheet.write_string_with_format(row_number, column as u16, text, &body_format)?;
      // Width follows the first line only — a wrapped cell's later lines do not
      // widen the column, and measuring them would push every column to the cap.
      let first_line = text.split('\n').next().unwrap_or_default();
      widths[column] = widths[column].max(display_width(first_line) + 2.0);
    }
  }

  for (column, width) in widths.iter().enumerate() {
    worksheet.set_column_width(column as u16, width.min(MAX_COLUMN_WIDTH))?;
  }

  let last_row = export.rows.len() as u32;
  let last_column = (columns - 1) as u16;
  worksheet.autofilter(0, 0, last_row, last_column)?;
  worksheet.set_freeze_panes(1, 0)?;

  workbook.save(path)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn export(headers: &[&str], rows: &[&[&str]]) -> PostingHistoryExport {
    PostingHistoryExport {
      sheet_name: "评论账本".to_string(),
      headers: headers.iter().map(|value| value.to_string()).collect(),
      rows: rows
        .iter()
        .map(|row| row.iter().map(|value| value.to_string()).collect())
        .collect(),
    }
  }

  #[test]
  fn writes_a_workbook_excel_will_open() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ledger.xlsx");
    let export = export(
      &["发布时间", "平台", "评论内容"],
      &[
        &["2026-08-10 16:31:04", "bilibili", "写得真好，\n受教了"],
        &["2026-08-10 16:28:49", "douyin", "=1+1"],
      ],
    );

    write_workbook(&export, &path).unwrap();

    // A workbook is a zip; the magic bytes are the cheapest proof that one was
    // produced rather than an empty or half-written file.
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..2], b"PK");
    assert!(bytes.len() > 1000);
  }

  /// A ragged row would silently shift every later column by one.
  #[test]
  fn a_row_that_does_not_match_the_headers_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ledger.xlsx");
    let export = export(&["a", "b"], &[&["1", "2"], &["1"]]);

    let error = write_workbook(&export, &path).unwrap_err();
    assert!(matches!(
      error,
      ExportError::RaggedRow {
        row: 1,
        actual: 1,
        expected: 2
      }
    ));
    assert!(!path.exists());
  }

  #[test]
  fn an_empty_ledger_is_an_error_not_a_header_only_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ledger.xlsx");

    assert!(matches!(
      write_workbook(&export(&["a"], &[]), &path).unwrap_err(),
      ExportError::NoRows
    ));
    assert!(matches!(
      write_workbook(&export(&[], &[]), &path).unwrap_err(),
      ExportError::NoColumns
    ));
  }

  /// Excel rejects the whole file over a name it dislikes; the rows matter more.
  #[test]
  fn sheet_names_are_made_acceptable_to_excel() {
    assert_eq!(sheet_name("评论账本"), "评论账本");
    assert_eq!(sheet_name("a/b:c*d?e[f]g"), "abcdefg");
    assert_eq!(sheet_name("   "), "Comments");
    assert_eq!(sheet_name(&"x".repeat(40)), "x".repeat(31));
  }

  #[test]
  fn an_oversized_cell_is_trimmed_on_a_character_boundary() {
    let long = "评".repeat(MAX_CELL_CHARS + 100);
    let trimmed = cell_text(&long);
    assert_eq!(trimmed.chars().count(), MAX_CELL_CHARS);
    assert!(long.starts_with(trimmed));
  }

  #[test]
  fn cjk_counts_double_so_columns_open_wide_enough() {
    assert_eq!(display_width("abcd"), 4.0);
    assert_eq!(display_width("评论"), 4.0);
  }
}
