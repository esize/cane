import { format } from "date-fns";

// Helper functions
export function roundHours(date: Date, interval: number): string {
  const hours = date.getUTCHours();
  const roundedHours = Math.floor(hours / interval) * interval;
  return roundedHours.toString().padStart(2, "0");
}

export function formatDateStamp(date: Date): string {
  return format(date, "yyyyMMdd") + roundHours(date, 6);
}
