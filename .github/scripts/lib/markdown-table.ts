/**
 * A markdown table cell of authored prose, refused rather than escaped: a pipe or a line break would split its row,
 * a blank one would leave its column empty, and an escape would silently change the rendered text. `where` names
 * the cell as its author knows it.
 */
export function tableCell(text: string, where: string): string {
  if (text.trim() === "" || /[|\r\n]/.test(text)) {
    throw new Error(
      `${where} is blank or contains "|" or a line break, which would break its table row: "${text}"`,
    );
  }
  return text;
}
