export type CalendarScrollMetrics = {
	dayLeft: number;
	gridLeft: number;
	clientLeft: number;
	scrollLeft: number;
	scrollPaddingStart: number;
	scrollWidth: number;
	clientWidth: number;
};

/** Compute the integer week offset between two YYYY-MM-DD Monday date keys. */
export function weekOffsetFromStarts(targetWeekStart: string, currentWeekStart: string): number {
	const targetMonday = new Date(`${targetWeekStart}T12:00:00`);
	const todayMonday = new Date(`${currentWeekStart}T12:00:00`);
	if (Number.isNaN(targetMonday.getTime()) || Number.isNaN(todayMonday.getTime())) return 0;
	return Math.round((targetMonday.getTime() - todayMonday.getTime()) / (7 * 86_400_000));
}

/** Calculate horizontal scrollLeft for a day card while preserving inline scroll padding and bounds. */
export function calendarDayScrollLeft(metrics: CalendarScrollMetrics): number {
	const scrollportLeft = metrics.gridLeft + metrics.clientLeft;
	const rawLeft =
		metrics.dayLeft - scrollportLeft + metrics.scrollLeft - (metrics.scrollPaddingStart || 0);
	const maxLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
	return Math.max(0, Math.min(rawLeft, maxLeft));
}
