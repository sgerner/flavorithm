import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDayScrollLeft, weekOffsetFromStarts } from '../src/lib/planner.ts';

function dateKey(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function weekStartForDate(value: string) {
	const date = new Date(`${value}T12:00:00`);
	if (Number.isNaN(date.getTime())) return value;
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return dateKey(date);
}

test('weekOffsetFromStarts computes Monday-relative week offsets across weekdays and DST boundaries', () => {
	const todayMonday = weekStartForDate('2026-11-19'); // Thursday -> 2026-11-16
	assert.equal(todayMonday, '2026-11-16');

	assert.equal(weekOffsetFromStarts(weekStartForDate('2026-11-16'), todayMonday), 0);
	assert.equal(weekOffsetFromStarts(weekStartForDate('2026-11-22'), todayMonday), 0);
	assert.equal(weekOffsetFromStarts(weekStartForDate('2026-11-24'), todayMonday), 1);
	assert.equal(weekOffsetFromStarts(weekStartForDate('2026-11-15'), todayMonday), -1);

	// Across US fall-back DST boundary (2026-11-01) and spring-forward DST boundary (2026-03-08)
	assert.equal(
		weekOffsetFromStarts(weekStartForDate('2026-11-04'), weekStartForDate('2026-10-28')),
		1
	);
	assert.equal(
		weekOffsetFromStarts(weekStartForDate('2026-03-11'), weekStartForDate('2026-03-04')),
		1
	);

	// Invalid date strings fall back safely to 0
	assert.equal(weekOffsetFromStarts('not-a-date', todayMonday), 0);
});

test('calendarDayScrollLeft preserves phone 16px inline snap gutter and handles existing scrollLeft', () => {
	// 390px phone viewport: grid has margin 0 -16px, padding 0 16px, scroll-padding-inline 16px,
	// 340px cards with 8px gap -> stride 348px; scrollWidth = 16 + 7*340 + 6*8 + 16 = 2460, clientWidth = 390
	const phoneMetrics = {
		gridLeft: 0,
		clientLeft: 0,
		scrollPaddingStart: 16,
		scrollWidth: 2460,
		clientWidth: 390
	};

	// Monday (index 0) at scrollLeft = 0 -> left = 0
	assert.equal(calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 0, dayLeft: 16 }), 0);

	// Thursday (index 3) at scrollLeft = 0 -> dayLeft = 16 + 3*348 = 1060 -> left = 1044
	assert.equal(calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 0, dayLeft: 1060 }), 1044);

	// Returning to Thursday when currently scrolled to Sunday (scrollLeft = 2070):
	// dayLeft in viewport is 1060 - 2070 = -1010 -> still computes exact left = 1044
	assert.equal(calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 2070, dayLeft: -1010 }), 1044);

	// Sunday (index 6) clamps cleanly to maxLeft = 2460 - 390 = 2070
	assert.equal(
		calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 0, dayLeft: 16 + 6 * 348 }),
		2070
	);
});

test('calendarDayScrollLeft aligns tablet cards inside border-left and clamps at max scroll', () => {
	// 768px tablet viewport: 1px border-left, 0 inline padding, 164px cards, 0 gap
	const tabletMetrics = {
		gridLeft: 218,
		clientLeft: 1,
		scrollPaddingStart: 0,
		scrollWidth: 1148,
		clientWidth: 520
	};

	// Wednesday (index 2): dayLeft = 219 + 2*164 = 547 -> left = 328
	assert.equal(calendarDayScrollLeft({ ...tabletMetrics, scrollLeft: 0, dayLeft: 547 }), 328);

	// Sunday (index 6): rawLeft = 984 -> clamped to 1148 - 520 = 628
	assert.equal(
		calendarDayScrollLeft({ ...tabletMetrics, scrollLeft: 0, dayLeft: 219 + 6 * 164 }),
		628
	);
});
