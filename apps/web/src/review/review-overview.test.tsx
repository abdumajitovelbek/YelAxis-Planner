// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewApplication, ReviewHistoryPage, ReviewOverview } from '@yelaxis/application';
import type { Instant } from '@yelaxis/domain';

import {
  bounded,
  currentWeekPeriod,
  dailyPeriod,
  fakeReviews,
  monthlyPeriod,
  reviewCheckpoint,
  reviewId,
  reviewOverview,
  reviewPeriod,
  reviewSummary,
  reviewTree,
  weeklyPeriod,
  yearlyPeriod,
} from './__fixtures__/review-fake';
import { ReviewOverviewPage } from './review-overview';

afterEach(() => cleanup());

const emptyPage: ReviewHistoryPage = { items: [] };

function renderOverview(
  options: {
    readonly overview?: ReviewOverview;
    readonly reviews?: Partial<ReviewApplication>;
  } = {},
) {
  const getOverview = vi.fn<ReviewApplication['getOverview']>(() =>
    Promise.resolve(options.overview ?? reviewOverview()),
  );
  const listHistory = vi.fn<ReviewApplication['listHistory']>(() => Promise.resolve(emptyPage));
  const reviews = fakeReviews({ getOverview, listHistory, ...options.reviews });
  render(reviewTree(reviews, <ReviewOverviewPage />));
  return { getOverview, listHistory, reviews, user: userEvent.setup() };
}

const card = (name: string) =>
  screen.getByRole('heading', { level: 3, name }).closest('li') as HTMLElement;

describe('Review overview', () => {
  it('shows one card per checkpoint with its period, status, due text, and one link', async () => {
    const { getOverview } = renderOverview();
    expect(screen.getByRole('status')).toHaveTextContent('Opening Review…');
    expect(await screen.findByRole('heading', { level: 2, name: 'Current reviews' })).toBeVisible();
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Current reviews', 'In progress', 'History']);
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Daily review', 'Weekly review', 'Monthly review', 'Yearly review']);

    const daily = card('Daily review');
    expect(daily).toHaveTextContent('Today, Wednesday, September 30');
    expect(daily).toHaveTextContent('Not started');
    expect(daily).toHaveTextContent('Due today');
    // The daily review is End Day for today.
    expect(within(daily).getByRole('link', { name: 'Start review (daily)' })).toHaveAttribute(
      'href',
      '/end-day/2026-09-30',
    );

    const weekly = card('Weekly review');
    expect(weekly).toHaveTextContent('Week of September 21–27');
    expect(weekly).toHaveTextContent('Saved for later');
    expect(weekly).toHaveTextContent('Ready when you are');
    expect(within(weekly).getByRole('link', { name: 'Resume review (weekly)' })).toHaveAttribute(
      'href',
      '/review/weekly/2026-09-21',
    );

    const monthly = card('Monthly review');
    expect(monthly).toHaveTextContent('September 2026');
    expect(monthly).toHaveTextContent('Due today');
    expect(within(monthly).getByRole('link', { name: 'Start review (monthly)' })).toHaveAttribute(
      'href',
      '/review/monthly/2026-09',
    );

    const yearly = card('Yearly review');
    expect(yearly).toHaveTextContent('2026');
    expect(yearly).toHaveTextContent('Due Thursday, December 31');
    expect(within(yearly).getByRole('link', { name: 'Start early (yearly)' })).toHaveAttribute(
      'href',
      '/review/yearly/2026',
    );
    // Each card has exactly one link.
    for (const name of ['Daily review', 'Weekly review', 'Monthly review', 'Yearly review'])
      expect(within(card(name)).getAllByRole('link')).toHaveLength(1);
  });

  it('shows finished and skipped checkpoints without due text', async () => {
    renderOverview({
      overview: reviewOverview({
        checkpoints: [
          reviewCheckpoint(
            dailyPeriod,
            'due',
            'completed',
            reviewSummary(dailyPeriod, { state: 'completed' }),
          ),
          reviewCheckpoint(
            currentWeekPeriod,
            'not_due',
            'skipped',
            reviewSummary(currentWeekPeriod, { state: 'skipped' }),
          ),
          reviewCheckpoint(monthlyPeriod, 'due', 'draft', reviewSummary(monthlyPeriod)),
          reviewCheckpoint(yearlyPeriod, 'not_due', 'draft', reviewSummary(yearlyPeriod)),
        ],
      }),
    });
    await screen.findByRole('heading', { level: 3, name: 'Daily review' });
    const daily = card('Daily review');
    expect(daily).toHaveTextContent('Done');
    expect(daily).not.toHaveTextContent('Due');
    expect(within(daily).getByRole('link', { name: 'Open review (daily)' })).toBeVisible();
    const weekly = card('Weekly review');
    expect(weekly).toHaveTextContent('Week of September 28 – October 4');
    expect(weekly).toHaveTextContent('Skipped');
    expect(weekly).not.toHaveTextContent('Due');
    expect(within(weekly).getByRole('link', { name: 'Open review (weekly)' })).toBeVisible();
    expect(card('Monthly review')).toHaveTextContent('Saved for later');
    // A draft started early resumes; it is never "early" again.
    expect(
      within(card('Yearly review')).getByRole('link', { name: 'Resume review (yearly)' }),
    ).toBeVisible();
  });

  it('lists other reviews in progress, and says so calmly when there are none', async () => {
    const earlier = reviewPeriod('weekly', '2026-09-14');
    renderOverview({
      overview: reviewOverview({
        inProgress: bounded(
          [
            reviewSummary(earlier, {
              reviewId: reviewId(510),
              decisionCount: 2,
              notesExcerpt: 'Half written.',
            }),
            reviewSummary(reviewPeriod('daily', '2026-09-26'), { reviewId: reviewId(511) }),
          ],
          21,
        ),
      }),
    });
    const list = await screen.findByRole('list', { name: 'Reviews in progress' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement).getByRole('link', {
        name: 'Week of September 14–20 (weekly review)',
      }),
    ).toHaveAttribute('href', '/review/weekly/2026-09-14');
    expect(rows[0]).toHaveTextContent('Weekly review · Saved for later · 2 decisions');
    expect(rows[0]).toHaveTextContent('Half written.');
    expect(
      within(rows[1] as HTMLElement).getByRole('link', {
        name: 'Saturday, September 26, 2026 (daily review)',
      }),
    ).toHaveAttribute('href', '/end-day/2026-09-26');
    expect(screen.getByText('Showing 2 of 21.')).toBeVisible();

    cleanup();
    renderOverview();
    expect(await screen.findByText('No other reviews are saved for later.')).toBeVisible();
  });

  it('shows history with its words, and an empty history calmly', async () => {
    const { listHistory } = renderOverview();
    expect(await screen.findByText('Finished and skipped reviews will appear here.')).toBeVisible();
    expect(listHistory).toHaveBeenCalledWith({});
    cleanup();

    const finished = reviewSummary(weeklyPeriod, {
      reviewId: reviewId(520),
      state: 'completed',
      decisionCount: 3,
      completedAt: '2026-09-28T19:05:00.000Z' as Instant,
    });
    const skipped = reviewSummary(reviewPeriod('daily', '2026-09-27'), {
      reviewId: reviewId(521),
      state: 'skipped',
      energy: 'low',
    });
    renderOverview({
      reviews: { listHistory: vi.fn(() => Promise.resolve({ items: [finished, skipped] })) },
    });
    const history = await screen.findByRole('list', { name: 'Review history' });
    const [first, second] = within(history).getAllByRole('listitem');
    expect(
      within(first as HTMLElement).getByRole('link', {
        name: 'Week of September 21–27 (weekly review)',
      }),
    ).toHaveAttribute('href', '/review/weekly/2026-09-21');
    expect(first).toHaveTextContent(
      'Weekly review · Done · 3 decisions · Finished Monday, September 28, 2026 at 19:05',
    );
    expect(
      within(second as HTMLElement).getByRole('link', {
        name: 'Sunday, September 27, 2026 (daily review)',
      }),
    ).toHaveAttribute('href', '/end-day/2026-09-27');
    expect(second).toHaveTextContent('Daily review · Skipped · Energy: Low');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('filters history by type and says so when a type has none yet', async () => {
    const monthly = reviewSummary(monthlyPeriod, { reviewId: reviewId(530), state: 'completed' });
    const listHistory = vi.fn<ReviewApplication['listHistory']>((options) =>
      Promise.resolve(options?.type === 'monthly' ? { items: [monthly] } : emptyPage),
    );
    const { user } = renderOverview({ reviews: { listHistory } });
    const filter = await screen.findByRole('group', { name: 'Review type' });
    expect(
      within(filter)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['All', 'Daily', 'Weekly', 'Monthly', 'Yearly']);
    expect(within(filter).getByRole('radio', { name: 'All' })).toBeChecked();

    await user.click(within(filter).getByRole('radio', { name: 'Weekly' }));
    await waitFor(() => expect(listHistory).toHaveBeenLastCalledWith({ type: 'weekly' }));
    expect(
      await screen.findByText('Finished and skipped weekly reviews will appear here.'),
    ).toBeVisible();

    await user.click(within(filter).getByRole('radio', { name: 'Monthly' }));
    await waitFor(() => expect(listHistory).toHaveBeenLastCalledWith({ type: 'monthly' }));
    expect(
      await screen.findByRole('link', { name: 'September 2026 (monthly review)' }),
    ).toHaveAttribute('href', '/review/monthly/2026-09');
  });

  it('shows more history page by page and moves focus to the first added review', async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        reviewSummary(
          reviewPeriod('daily', `2026-08-${String(28 - start - index).padStart(2, '0')}`),
          { reviewId: reviewId(600 + start + index), state: 'completed' },
        ),
      );
    const listHistory = vi.fn<ReviewApplication['listHistory']>((options) =>
      Promise.resolve(
        options?.cursor === undefined
          ? { items: page(0, 2), nextCursor: 'cursor-2' }
          : { items: page(2, 1) },
      ),
    );
    const { user } = renderOverview({ reviews: { listHistory } });
    const history = await screen.findByRole('list', { name: 'Review history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(listHistory).toHaveBeenLastCalledWith({ cursor: 'cursor-2' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(3));
    const added = within(history).getAllByRole('link')[2];
    expect(added).toHaveAccessibleName('Wednesday, August 26, 2026 (daily review)');
    await waitFor(() => expect(added).toHaveFocus());
    // The last page has no Show more.
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('keeps the filter with its paging', async () => {
    const listHistory = vi.fn<ReviewApplication['listHistory']>((options) =>
      Promise.resolve(
        options?.cursor === undefined
          ? {
              items: [reviewSummary(yearlyPeriod, { reviewId: reviewId(700), state: 'skipped' })],
              nextCursor: 'next',
            }
          : { items: [] },
      ),
    );
    const { user } = renderOverview({ reviews: { listHistory } });
    await user.click(await screen.findByRole('radio', { name: 'Yearly' }));
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() =>
      expect(listHistory).toHaveBeenLastCalledWith({ type: 'yearly', cursor: 'next' }),
    );
  });

  it('reports a failed read calmly and tries again', async () => {
    let calls = 0;
    const getOverview = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('worker')) : Promise.resolve(reviewOverview());
    });
    const { user } = renderOverview({ reviews: { getOverview } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Review could not be read. Your local plan was not changed.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Current reviews' })).toBeVisible();
  });

  it('reports a failed history read calmly and tries again', async () => {
    let calls = 0;
    const listHistory = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('worker')) : Promise.resolve(emptyPage);
    });
    const { user } = renderOverview({ reviews: { listHistory } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'History could not be read. Your local plan was not changed.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Finished and skipped reviews will appear here.')).toBeVisible();
  });

  it('uses calm, neutral words only', async () => {
    renderOverview();
    await screen.findByRole('heading', { level: 3, name: 'Yearly review' });
    const text = document.body.textContent;
    for (const word of [
      /streak/iu,
      /score/iu,
      /grade/iu,
      /overdue/iu,
      /behind/iu,
      /failed/iu,
      /missed/iu,
      /late\b/iu,
      /\bAI\b/u,
      /%/u,
    ])
      expect(text).not.toMatch(word);
  });
});
