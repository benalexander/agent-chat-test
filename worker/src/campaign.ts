import type { CampaignState, Donation } from '@agent-chat/shared';
import { MILESTONES } from './config';

const DAY = 86_400_000;

export function seedCampaign(now: number): CampaignState {
  const donations: Donation[] = [
    { id: 'seed-1', donorName: 'Mum & Dad', amount: 50, message: 'So proud of you! Go get it.', at: now - 6 * DAY },
    { id: 'seed-2', donorName: 'Priya S.', amount: 25, message: 'Smash it!', at: now - 4 * DAY },
    { id: 'seed-3', donorName: 'Anonymous', amount: 20, at: now - 2 * DAY },
    { id: 'seed-4', donorName: 'Tom W.', amount: 25, message: 'Great cause, mate.', at: now - 1 * DAY },
  ];
  return {
    name: 'Ridgeway Half Marathon',
    charity: 'Beyond Blue',
    currency: 'AUD',
    target: 500,
    raised: donations.reduce((s, d) => s + d.amount, 0),
    donorCount: donations.length,
    startedAt: now,
    endsAt: now + 42 * DAY,
    donations,
    // 120/500 = 24%: no milestone reached yet.
    milestonesHit: [],
    lastActivityAt: now,
  };
}

export function percentRaised(c: CampaignState): number {
  return c.target > 0 ? Math.round((c.raised / c.target) * 1000) / 10 : 0;
}

export function daysLeft(c: CampaignState, now: number): number {
  return Math.max(0, Math.ceil((c.endsAt - now) / DAY));
}

export interface DonationResult {
  campaign: CampaignState;
  donation: Donation;
  /** Milestones newly crossed by this donation (ascending). */
  crossed: number[];
}

export function applyDonation(
  c: CampaignState,
  input: { amount: number; donorName?: string; message?: string },
  now: number,
  id: string,
): DonationResult {
  const donation: Donation = {
    id,
    donorName: input.donorName?.trim() || 'Anonymous',
    amount: Math.round(input.amount),
    ...(input.message ? { message: input.message } : {}),
    at: now,
  };
  const before = percentRaised(c);
  const raised = c.raised + donation.amount;
  const after = c.target > 0 ? (raised / c.target) * 100 : 0;
  const crossed = MILESTONES.filter((m) => before < m && after >= m && !c.milestonesHit.includes(m));
  return {
    donation,
    crossed: [...crossed],
    campaign: {
      ...c,
      raised,
      donorCount: c.donorCount + 1,
      donations: [...c.donations, donation],
      milestonesHit: [...c.milestonesHit, ...crossed].sort((a, b) => a - b),
      lastActivityAt: now,
    },
  };
}

export function campaignSummary(c: CampaignState, now: number) {
  return {
    name: c.name,
    charity: c.charity,
    currency: c.currency,
    target: c.target,
    raised: c.raised,
    percentRaised: percentRaised(c),
    remaining: Math.max(0, c.target - c.raised),
    donorCount: c.donorCount,
    daysLeft: daysLeft(c, now),
    endsOn: new Date(c.endsAt).toISOString().slice(0, 10),
    milestonesHit: c.milestonesHit,
  };
}

export function recentDonations(c: CampaignState, limit: number) {
  return [...c.donations]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((d) => ({
      donorName: d.donorName,
      amount: d.amount,
      message: d.message ?? null,
      when: new Date(d.at).toISOString(),
    }));
}
