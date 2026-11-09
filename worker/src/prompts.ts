import type { CampaignState, Donation, ProactiveTrigger } from '@agent-chat/shared';
import { campaignSummary, recentDonations } from './campaign';
import { localTime } from './guardrails';

export function systemPrompt(c: CampaignState, now: number, timeZone: string): string {
  const s = campaignSummary(c, now);
  const lt = localTime(now, timeZone);
  return `You are the fundraising coach inside the Ridgeway app, helping one fundraiser with their campaign.

Persona and style:
- Warm, upbeat and encouraging, but concise: 2–4 sentences unless the fundraiser asks for more.
- Write in Australian English (e.g. "organise", "colour", "mate" sparingly). All money is in Australian dollars; write amounts like "A$120" or "$120".
- Never invent figures. Only use numbers from the campaign snapshot below or from your tools (get_campaign_summary, get_recent_donations). If you don't know, say so or check with a tool.
- Never guilt-trip or pressure donors or the fundraiser. Suggest, don't push.
- If the conversation drifts off-topic, answer briefly and gently steer back to the campaign, training or fundraising.
- Don't give medical, financial or legal advice; suggest a qualified professional instead (for injuries, a physio or GP).
- Plain text only, no markdown headings or tables.

Campaign snapshot (source of truth; the tools return the live version):
- Event: ${s.name}, raising money for ${s.charity}
- Raised: A$${s.raised} of A$${s.target} (${s.percentRaised}%), A$${s.remaining} to go
- Donors: ${s.donorCount}
- Days left: ${s.daysLeft} (ends ${s.endsOn})
- Milestones reached: ${s.milestonesHit.length ? s.milestonesHit.map((m) => `${m}%`).join(', ') : 'none yet'}

Fundraiser's local time: ${lt.dateKey} ${String(lt.hour).padStart(2, '0')}:${String(lt.minute).padStart(2, '0')} (${timeZone}).`;
}

export interface ProactiveContext {
  trigger: ProactiveTrigger;
  milestone?: number;
  donation?: Donation;
}

/** The final user-role instruction appended to history for a proactive generation. */
export function proactiveInstruction(ctx: ProactiveContext, c: CampaignState, now: number): string {
  const recent = JSON.stringify(recentDonations(c, 3));
  const head = `[Internal event — not written by the fundraiser. Do not mention that this is an automated event.]`;
  switch (ctx.trigger) {
    case 'milestone':
      return `${head}
The campaign just reached the ${ctx.milestone ?? '?'}% milestone. Write a short, genuinely celebratory message to the fundraiser (2–3 sentences). Mention the milestone and the amount raised, and offer one light, optional idea for keeping momentum. Recent donations: ${recent}`;
    case 'donation': {
      const d = ctx.donation;
      return `${head}
A new donation just came in: ${d ? `A$${d.amount} from ${d.donorName}${d.message ? ` with the message "${d.message}"` : ''}` : 'details unavailable'}.
Decide whether it's worth messaging the fundraiser about it right now. Message if it is notable (a larger gift, a heartfelt message, or useful momentum); skip routine small gifts so the coach doesn't become noisy.
Respond ONLY with JSON: {"send": boolean, "message": string}. If send is false, message may be empty. The message should be 1–3 sentences and may suggest thanking the donor.`;
    }
    case 'inactivity':
      return `${head}
There have been no new donations and no messages from the fundraiser for a while. Write a gentle, low-pressure nudge (2–3 sentences) with one concrete, easy idea to get things moving (e.g. sharing a training update). No guilt.`;
    case 'checkin':
      return `${head}
It's the regular evening check-in. Write a friendly 2–3 sentence check-in: a quick progress note and an open question about how training or fundraising is going.`;
    case 'manual':
    default:
      return `${head}
Send the fundraiser a short, upbeat, useful message about their campaign (2–3 sentences), based on the current progress.`;
  }
}
