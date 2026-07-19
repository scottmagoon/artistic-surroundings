// Small text-formatting helpers shared by page templates.

/** Split "{location} — {date}" or "{event} — {location} — {date}" into
 *  { heading, dateLabel }: the last " — "-delimited segment is the date. */
export function splitDisplayTitle(title) {
  const parts = title.split(" — ");
  if (parts.length < 2) return { heading: title, dateLabel: "" };
  const dateLabel = parts[parts.length - 1];
  const heading = parts.slice(0, -1).join(" — ");
  return { heading, dateLabel };
}

/** uiText.countWords is "events · photographs" — split into the two nouns. */
export function countWordParts(countWords) {
  const parts = countWords.split("·").map((s) => s.trim());
  return { eventWord: parts[0] || "events", photoWord: parts[1] || "photographs" };
}
