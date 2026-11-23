import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};
const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!url || !serviceKey) throw new Error("Supabase server credentials are not configured.");
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function fail(message: string, status = 400) { return reply({ success: false, error: message }, status); }
function dateInLome() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function isWeekday(day: string) {
  const d = new Date(day + "T12:00:00Z").getUTCDay();
  return d >= 1 && d <= 5;
}
function safeName(v: string) { return v.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100); }
async function uploadEvidence(userId: string, base64: string, mime: string, filename: string) {
  const allowed: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  if (!allowed[mime]) throw new Error("Evidence must be a JPG, PNG or WEBP image.");
  if (typeof base64 !== "string" || base64.length > 7_000_000) throw new Error("Evidence image is too large.");
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  if (bytes.length > 5 * 1024 * 1024) throw new Error("Evidence image must be 5 MB or smaller.");
  const path = "evidence/" + userId + "/" + crypto.randomUUID() + "-" + safeName(filename || ("proof." + allowed[mime]));
  const { error } = await admin.storage.from("earn360-private").upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw error;
  return path;
}
async function signedEvidence(path: string | null) {
  if (!path) return null;
  const { data, error } = await admin.storage.from("earn360-private").createSignedUrl(path, 3600);
  return error ? null : data.signedUrl;
}
async function getUser(req: Request) {
  const h = req.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) throw new Error("Please log in to continue.");
  const token = h.slice(7);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("Your session is invalid or has expired.");
  const { data: profile, error: pErr } = await admin.from("profiles").select("id,full_name,phone,referral_code,referred_by,role,country,display_currency").eq("id", data.user.id).single();
  if (pErr || !profile) throw new Error("Your member profile is not ready. Please contact Earn360 support.");
  return { user: data.user, profile };
}
async function requireAdmin(profile: any) {
  if (!["admin", "super_admin"].includes(profile.role)) throw new Error("Administrator access required.");
}
async function one(query: any) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
async function getActiveMembership(userId: string) {
  const rows = await one(admin.from("memberships").select("id,user_id,plan_id,status,purchased_at,starts_at,ends_at,earning_days_completed,membership_plans(id,name,price_usd,weekly_reward_usd)").eq("user_id", userId).eq("status", "active").order("purchased_at", { ascending: false }).limit(1));
  const m = rows?.[0] ?? null;
  if (m?.ends_at && new Date(m.ends_at).getTime() < Date.now()) {
    await admin.from("memberships").update({ status: "expired" }).eq("id", m.id);
    return null;
  }
  return m;
}
async function statsFor(userId: string) {
  const [wallet, txs, withdrawals] = await Promise.all([
    one(admin.from("wallets").select("balance").eq("user_id", userId).maybeSingle()),
    one(admin.from("wallet_transactions").select("transaction_type,amount,status").eq("user_id", userId)),
    one(admin.from("withdrawal_requests").select("amount,status").eq("user_id", userId)),
  ]);
  const successful = (txs || []).filter((x: any) => x.status === "successful");
  const earned = successful.filter((x: any) => ["task_reward", "referral_commission"].includes(x.transaction_type)).reduce((a: number, x: any) => a + Number(x.amount || 0), 0);
  const withdrawn = (withdrawals || []).filter((x: any) => x.status === "paid").reduce((a: number, x: any) => a + Number(x.amount || 0), 0);
  const pending = (withdrawals || []).filter((x: any) => x.status === "pending" || x.status === "approved").reduce((a: number, x: any) => a + Number(x.amount || 0), 0);
  return { available_balance: Number(wallet?.balance || 0), total_earned: earned, total_withdrawn: withdrawn, pending_withdrawals: pending };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { user, profile } = await getUser(req);
    const u = user.id;
    const path = new URL(req.url).pathname.replace(/^.*\/functions\/v1\/earn360-api/, "") || "/";
    const method = req.method;
    const body = method === "GET" ? {} : await req.json().catch(() => ({}));

    if (method === "GET" && path === "/api/subscriptions/plans") {
      const plans = await one(admin.from("membership_plans").select("id,name,price_usd,weekly_reward_usd,active").eq("active", true).order("price_usd"));
      return reply({ plans: (plans || []).map((p: any) => ({ ...p, price: p.price_usd, weekly: p.weekly_reward_usd, featured: p.name === "Silver" })) });
    }

    if (method === "GET" && path === "/api/member/dashboard") {
      const [subscription, wallet] = await Promise.all([getActiveMembership(u), statsFor(u)]);
      return reply({ subscription: subscription ? {
        id: subscription.id, plan_name: subscription.membership_plans?.name,
        weekly_reward_usd: Number(subscription.membership_plans?.weekly_reward_usd || 0),
        earning_days_completed: subscription.earning_days_completed || 0,
        status: subscription.status, starts_at: subscription.starts_at, ends_at: subscription.ends_at,
      } : null, wallet });
    }

    if (method === "GET" && path === "/api/member/wallet") {
      const wallet = await statsFor(u);
      return reply(wallet);
    }

    if (method === "GET" && path === "/api/member/transactions") {
      const rows = await one(admin.from("wallet_transactions").select("id,transaction_type,amount,reference,status,description,created_at").eq("user_id", u).order("created_at", { ascending: false }).limit(100));
      return reply({ transactions: (rows || []).map((x: any) => ({
        id: x.id, type: x.transaction_type, amount_usd: Number(x.amount), status: x.status,
        description: x.description || x.transaction_type, created_at: x.created_at,
        direction: ["deposit", "task_reward", "refund", "referral_commission"].includes(x.transaction_type) ? "credit" : "debit",
      })) });
    }

    if (method === "GET" && path === "/api/member/referrals") {
      const refs = await one(admin.from("earn360_referrals").select("referred_user_id,referral_code,created_at,commission_amount,commission_paid_at").eq("referrer_user_id", u).order("created_at", { ascending: false }));
      const ids = (refs || []).map((x: any) => x.referred_user_id);
      const profiles = ids.length ? await one(admin.from("profiles").select("id,full_name").in("id", ids)) : [];
      const memberships = ids.length ? await one(admin.from("memberships").select("user_id,status,membership_plans(name)").in("user_id", ids)) : [];
      const names = new Map((profiles || []).map((x: any) => [x.id, x.full_name]));
      const subs = new Map((memberships || []).map((x: any) => [x.user_id, x]));
      return reply({
        referral_code: profile.referral_code,
        invited_count: (refs || []).length,
        active_paying_count: (memberships || []).filter((x: any) => x.status === "active").length,
        commission_earned_usd: (refs || []).reduce((a: number, x: any) => a + Number(x.commission_amount || 0), 0),
        referrals: (refs || []).map((x: any) => ({ member_name: names.get(x.referred_user_id) || "Member", joined_at: x.created_at, status: subs.get(x.referred_user_id)?.status || "Registered", plan_name: subs.get(x.referred_user_id)?.membership_plans?.name || "—" })),
      });
    }

    if (method === "GET" && path === "/api/member/deposits") {
      const rows = await one(admin.from("deposits").select("id,amount,currency,payment_method,transaction_id,purpose,status,created_at").eq("user_id", u).order("created_at", { ascending: false }).limit(100));
      return reply({ deposits: (rows || []).map((x: any) => ({ id: x.id, amount_usd: Number(x.amount), purpose: x.purpose, reference: x.transaction_id, status: x.status, created_at: x.created_at })) });
    }

    if (method === "GET" && path === "/api/member/withdrawals") {
      const rows = await one(admin.from("withdrawal_requests").select("id,amount,fee,net_amount,payment_method,account_details,payout_reference,status,admin_note,created_at").eq("user_id", u).order("created_at", { ascending: false }).limit(100));
      return reply({ withdrawals: (rows || []).map((x: any) => ({ id: x.id, gross_usd: Number(x.amount), fee_usd: Number(x.fee), net_usd: Number(x.net_amount), method: x.payment_method, payout_reference: x.payout_reference, payout_email: x.account_details, status: x.status === "paid" ? "completed" : x.status, admin_note: x.admin_note, created_at: x.created_at, payout_confirmation_reference: x.payout_reference })) });
    }

    if (method === "GET" && path === "/api/payment-details") {
      const row = await one(admin.from("earn360_settings").select("value").eq("key", "payment_details").maybeSingle());
      const v = row?.value || {};
      return reply({ payment_details: { paypal_email: v.paypal_email || "", instructions: v.instructions || "" } });
    }

    if (method === "PATCH" && path === "/api/member/preferences") {
      const country = String(body.country || "").toUpperCase();
      const currency = String(body.display_currency || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) return fail("Choose a valid country and display currency.");
      const { data, error } = await admin.from("profiles").update({ country, display_currency: currency }).eq("id", u).select("country,display_currency").single();
      if (error) throw error;
      return reply({ message: "Preferences updated.", member: data });
    }

    if (method === "POST" && path === "/api/subscriptions/select") {
      const planId = String(body.plan_id || "");
      const planQuery = admin.from("membership_plans").select("id,name,price_usd,active").eq("active", true);
      const plan = await one(/^[0-9a-f-]{36}$/i.test(planId) ? planQuery.eq("id", planId).maybeSingle() : planQuery.eq("name", planId).maybeSingle());
      if (!plan) return fail("That membership plan is not available.");
      const active = await getActiveMembership(u);
      if (active) return fail("You already have an active subscription.");
      const pending = await one(admin.from("memberships").select("id,plan_id,status").eq("user_id", u).eq("status", "pending").order("purchased_at", { ascending: false }).limit(1));
      if (pending?.[0]) {
        if (pending[0].plan_id !== plan.id) return fail("You already have a pending subscription request. Complete or cancel it first.");
        return reply({ message: "Your subscription request is already pending payment.", membership_id: pending[0].id });
      }
      const created = await one(admin.from("memberships").insert({ user_id: u, plan_id: plan.id, status: "pending" }).select("id").single());
      return reply({ message: "Subscription request created. Submit your PayPal payment proof to activate it after admin verification.", membership_id: created.id }, 201);
    }

    if (method === "POST" && path === "/api/member/deposits") {
      const amount = Number(body.amount_usd);
      const purpose = String(body.purpose || "").trim();
      const reference = String(body.reference || "").trim();
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return fail("Enter a valid payment amount.");
      if (!purpose || purpose.length > 120 || !reference || reference.length > 180) return fail("Payment purpose and PayPal transaction reference are required.");
      if (String(body.external_method || "PayPal") !== "PayPal") return fail("PayPal is the only official online payment method.");
      const duplicate = await one(admin.from("deposits").select("id").eq("transaction_id", reference).maybeSingle());
      if (duplicate) return fail("This PayPal transaction reference has already been submitted.");
      const evidencePath = await uploadEvidence(u, body.evidence_base64, body.evidence_mime, body.evidence_name || "payment-proof");
      let membershipId: string | null = null;
      const isWallet = ["wallet funding", "wallet top-up", "wallet top up", "wallet topup"].includes(purpose.toLowerCase());
      if (!isWallet) {
        const pending = await one(admin.from("memberships").select("id,plan_id,membership_plans(name,price_usd)").eq("user_id", u).eq("status", "pending").order("purchased_at", { ascending: false }).limit(1));
        const candidate = pending?.[0];
        if (!candidate) {
          await admin.storage.from("earn360-private").remove([evidencePath]);
          return fail("Select a membership plan first, then submit its payment proof.");
        }
        const expected = Number(candidate.membership_plans?.price_usd || 0);
        if (Math.abs(amount - expected) > 0.009) {
          await admin.storage.from("earn360-private").remove([evidencePath]);
          return fail("The payment amount must match the selected membership price of $" + expected.toFixed(2) + ".");
        }
        membershipId = candidate.id;
      }
      const inserted = await one(admin.from("deposits").insert({
        user_id: u, amount, currency: "USD", payment_method: "PayPal",
        transaction_id: reference, proof_url: evidencePath, purpose, membership_id: membershipId, status: "pending",
      }).select("id").single());
      return reply({ message: "Payment details and photo proof submitted for manual review.", deposit_id: inserted.id }, 201);
    }

    if (method === "POST" && path === "/api/member/withdrawals") {
      const amount = Number(body.gross_usd);
      const methodName = String(body.method || "PayPal");
      const destination = String(body.destination_details || "");
      const requestKey = String(body.request_key || "");
      const { data, error } = await admin.rpc("earn360_request_withdrawal", {
        p_user_id: u, p_amount: amount, p_method: methodName, p_destination: destination, p_request_key: requestKey,
      });
      if (error) throw error;
      return reply({ message: "PayPal withdrawal request submitted for admin review.", withdrawal: data }, 201);
    }

    if (method === "GET" && path === "/api/activities/today") {
      const day = dateInLome();
      const sub = await getActiveMembership(u);
      const submission = await one(admin.from("earn360_activity_submissions").select("id,activity_type,verified_steps,videos_completed,status,admin_note").eq("user_id", u).eq("earning_date", day).maybeSingle());
      if (!sub) return reply({ activity_completed: false, message: "Activate a subscription to unlock daily earning activities.", progress_percent: 0, videos: [] });
      if (!isWeekday(day)) return reply({ activity_completed: false, message: "Daily earning activities are available Monday to Friday.", progress_percent: 0, videos: [] });
      if (submission) return reply({ activity_completed: submission.status === "approved", message: submission.status === "approved" ? "Your activity has been approved." : submission.status === "rejected" ? "Your activity was rejected: " + (submission.admin_note || "Contact support.") : "Your activity submission is awaiting admin verification.", activity_label: submission.activity_type === "walk" ? "Walk & Earn" : "Watch & Earn", verified_steps: submission.verified_steps, steps_status: submission.activity_type === "walk" ? submission.status : null, steps_progress_percent: Math.min(100, Number(submission.verified_steps || 0) / 4000 * 100), progress_percent: submission.status === "approved" ? 100 : 0, videos: [] });
      const start = sub.starts_at || sub.purchased_at;
      const used = await one(admin.from("earn360_video_assignments").select("video_id").eq("user_id", u).gte("earning_date", String(start).slice(0, 10)));
      const usedIds = new Set((used || []).map((x: any) => x.video_id));
      const allVideos = await one(admin.from("earn360_videos").select("id,title,storage_path,duration_seconds,sequence_number").eq("active", true).order("sequence_number").limit(120));
      let assignments = await one(admin.from("earn360_video_assignments").select("id,video_id,position,completed_at,watched_seconds,earn360_videos(id,title,duration_seconds,storage_path)").eq("user_id", u).eq("earning_date", day).order("position"));
      if (!assignments?.length && (allVideos || []).length >= 4) {
        const fresh = allVideos.filter((v: any) => !usedIds.has(v.id)).slice(0, 4);
        if (fresh.length === 4) {
          const rows = fresh.map((v: any, i: number) => ({ user_id: u, earning_date: day, video_id: v.id, position: i + 1 }));
          await one(admin.from("earn360_video_assignments").insert(rows));
          assignments = await one(admin.from("earn360_video_assignments").select("id,video_id,position,completed_at,watched_seconds,earn360_videos(id,title,duration_seconds,storage_path)").eq("user_id", u).eq("earning_date", day).order("position"));
        }
      }
      const videos = [];
      for (const a of assignments || []) {
        const { data: signed } = await admin.storage.from("earn360-video-library").createSignedUrl(a.earn360_videos.storage_path, 3600);
        videos.push({ id: a.video_id, title: a.earn360_videos.title, duration_seconds: a.earn360_videos.duration_seconds, url: signed?.signedUrl || null, completed: !!a.completed_at, watched_seconds: a.watched_seconds || 0 });
      }
      const wallet = await statsFor(u);
      const weekly = Number(sub.membership_plans?.weekly_reward_usd || 0);
      return reply({ activity_completed: false, message: videos.length === 4 ? "Watch all four assigned videos, or submit 4,000 steps with a screenshot for review." : "The private video library is not ready yet. Walk & Earn remains available with a screenshot for admin verification.", activity_label: videos.length === 4 ? "4 assigned videos or 4,000 steps" : "4,000 steps", reward_display: "$" + (weekly / 5).toFixed(2), progress_percent: 0, verified_steps: 0, steps_progress_percent: 0, videos });
    }

    if (method === "POST" && path === "/api/activities/watch/progress") {
      const videoId = String(body.video_id || "");
      const watched = Math.max(0, Math.min(86400, Math.floor(Number(body.watched_seconds || 0))));
      const day = dateInLome();
      const assignment = await one(admin.from("earn360_video_assignments").select("id,video_id,earn360_videos(duration_seconds)").eq("user_id", u).eq("earning_date", day).eq("video_id", videoId).maybeSingle());
      if (!assignment) return fail("This video is not assigned to your account today.");
      const duration = Number(assignment.earn360_videos?.duration_seconds || 0);
      if (duration <= 0 || watched < Math.ceil(duration * 0.9)) return fail("Watch at least 90% of the assigned video before marking it complete.");
      const { error } = await admin.from("earn360_video_assignments").update({ watched_seconds: watched, completed_at: new Date().toISOString() }).eq("id", assignment.id);
      if (error) throw error;
      return reply({ success: true, message: "Video completion recorded." });
    }

    if (method === "POST" && path === "/api/activities/watch/complete") {
      const day = dateInLome();
      const completed = await one(admin.from("earn360_video_assignments").select("id,completed_at").eq("user_id", u).eq("earning_date", day));
      if (!completed || completed.length !== 4 || completed.some((x: any) => !x.completed_at)) return fail("Complete all four assigned videos before submitting Watch & Earn.");
      const { data, error } = await admin.from("earn360_activity_submissions").insert({ user_id: u, activity_type: "watch", earning_date: day, videos_completed: 4, status: "pending" }).select("id").single();
      if (error) throw error;
      return reply({ message: "Watch & Earn submitted for admin verification. Rewards are credited only after approval.", submission_id: data.id }, 201);
    }

    if (method === "POST" && path === "/api/activities/walk/sync") {
      const day = dateInLome();
      if (!isWeekday(day)) return fail("Walk & Earn submissions are available Monday to Friday.");
      const steps = Math.floor(Number(body.steps || 0));
      if (!Number.isInteger(steps) || steps < 4000 || steps > 100000) return fail("A step count from 4,000 to 100,000 is required.");
      const existing = await one(admin.from("earn360_activity_submissions").select("id").eq("user_id", u).eq("earning_date", day).maybeSingle());
      if (existing) return fail("You have already submitted today's earning activity.");
      const evidence = await uploadEvidence(u, body.evidence_base64, body.evidence_mime, body.evidence_name || "steps-proof");
      const { data, error } = await admin.from("earn360_activity_submissions").insert({ user_id: u, activity_type: "walk", earning_date: day, verified_steps: steps, evidence_path: evidence, status: "pending" }).select("id").single();
      if (error) {
        await admin.storage.from("earn360-private").remove([evidence]);
        throw error;
      }
      return reply({ message: "Walk & Earn evidence submitted. Your step count is pending admin verification; no reward is credited before approval.", submission_id: data.id }, 201);
    }

    if (method === "POST" && path === "/api/support/tickets") {
      const subject = String(body.subject || "").trim();
      const message = String(body.message || "").trim();
      if (!subject || subject.length > 160 || !message || message.length > 5000) return fail("Enter a subject and message (maximum 5,000 characters).");
      const ticket = await one(admin.from("support_tickets").insert({ user_id: u, subject, message }).select("id,status,created_at").single());
      return reply({ message: "Support request sent.", ticket }, 201);
    }

    if (path === "/api/admin/dashboard" && method === "GET") {
      await requireAdmin(profile);
      const [memberCount, pendingDeposits, pendingWithdrawals, activeSubs, videoCount, depositRows, withdrawalRows, activityRows] = await Promise.all([
        one(admin.from("profiles").select("id", { count: "exact", head: true })),
        one(admin.from("deposits").select("id", { count: "exact", head: true }).eq("status", "pending")),
        one(admin.from("withdrawal_requests").select("id", { count: "exact", head: true }).eq("status", "pending")),
        one(admin.from("memberships").select("id", { count: "exact", head: true }).eq("status", "active")),
        one(admin.from("earn360_videos").select("id", { count: "exact", head: true })),
        one(admin.from("deposits").select("id,user_id,amount,currency,payment_method,transaction_id,proof_url,purpose,status,created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(50)),
        one(admin.from("withdrawal_requests").select("id,user_id,amount,fee,net_amount,payment_method,account_details,status,created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(50)),
        one(admin.from("earn360_activity_submissions").select("id,user_id,activity_type,verified_steps,videos_completed,evidence_path,status,earning_date,created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(50)),
      ]);
      const ids = [...new Set([...(depositRows || []).map((x: any) => x.user_id), ...(withdrawalRows || []).map((x: any) => x.user_id), ...(activityRows || []).map((x: any) => x.user_id)])];
      const profiles = ids.length ? await one(admin.from("profiles").select("id,full_name").in("id", ids)) : [];
      const names = new Map((profiles || []).map((x: any) => [x.id, x.full_name]));
      const queue = [];
      for (const x of depositRows || []) queue.push({ id: x.id, type: "Deposit", title: "PayPal payment", member: names.get(x.user_id) || "Member", purpose: x.purpose, external_reference: x.transaction_id, created_at: x.created_at, status: x.status, evidence_signed_url: await signedEvidence(x.proof_url) });
      const withdrawal_queue = (withdrawalRows || []).map((x: any) => ({ id: x.id, member: names.get(x.user_id) || "Member", member_email: "", gross_usd: Number(x.amount), fee_usd: Number(x.fee), net_usd: Number(x.net_amount), payout_method: x.payment_method, payout_reference: x.account_details, created_at: x.created_at }));
      const activity_queue = [];
      for (const x of activityRows || []) activity_queue.push({ id: x.id, member: names.get(x.user_id) || "Member", activity_type: x.activity_type, steps: x.verified_steps, videos_completed: x.videos_completed, earning_date: x.earning_date, created_at: x.created_at, evidence_signed_url: await signedEvidence(x.evidence_path) });
      return reply({ member_count: memberCount?.count || 0, pending_deposits: pendingDeposits?.count || 0, pending_withdrawals: pendingWithdrawals?.count || 0, active_subscriptions: activeSubs?.count || 0, video_count: videoCount?.count || 0, queue, withdrawal_queue, activity_queue });
    }


    if (path === "/api/admin/videos/upload-url" && method === "POST") {
      await requireAdmin(profile);
      const title = String(body.title || "").trim().slice(0, 160);
      const filename = String(body.filename || "video.mp4");
      const mime = String(body.mime_type || "");
      const duration = Math.floor(Number(body.duration_seconds || 0));
      if (!title || !["video/mp4", "video/webm"].includes(mime) || duration < 1 || duration > 7200) return fail("Choose an MP4 or WebM video with valid duration metadata.");
      const { count, error: countError } = await admin.from("earn360_videos").select("id", { count: "exact", head: true });
      if (countError) throw countError;
      if ((count || 0) >= 120) return fail("The private video library already contains 120 videos.");
      const last = await one(admin.from("earn360_videos").select("sequence_number").order("sequence_number", { ascending: false }).limit(1));
      const sequence = Number(last?.[0]?.sequence_number || 0) + 1;
      const pathName = "videos/" + String(sequence).padStart(3, "0") + "-" + crypto.randomUUID() + "-" + safeName(filename);
      const { data: signed, error: signedError } = await admin.storage.from("earn360-video-library").createSignedUploadUrl(pathName);
      if (signedError) throw signedError;
      const video = await one(admin.from("earn360_videos").insert({ title, storage_path: pathName, duration_seconds: duration, sequence_number: sequence, active: false }).select("id").single());
      return reply({ video_id: video.id, path: pathName, token: signed.token, sequence_number: sequence }, 201);
    }

    if (path === "/api/admin/videos/activate" && method === "POST") {
      await requireAdmin(profile);
      const videoId = String(body.video_id || "");
      const video = await one(admin.from("earn360_videos").select("id,storage_path,active").eq("id", videoId).maybeSingle());
      if (!video) return fail("Video upload record was not found.");
      const { error: fileError } = await admin.storage.from("earn360-video-library").createSignedUrl(video.storage_path, 60);
      if (fileError) return fail("The video file has not finished uploading.");
      const { error } = await admin.from("earn360_videos").update({ active: true }).eq("id", videoId);
      if (error) throw error;
      return reply({ message: "Video added to the private Watch & Earn library.", video_id: videoId });
    }

    if (path === "/api/admin/videos/cancel" && method === "POST") {
      await requireAdmin(profile);
      const videoId = String(body.video_id || "");
      const video = await one(admin.from("earn360_videos").select("id,storage_path,active").eq("id", videoId).maybeSingle());
      if (!video) return reply({ success: true });
      if (video.active) return fail("An active video cannot be removed through upload cancellation.");
      await admin.storage.from("earn360-video-library").remove([video.storage_path]);
      const { error } = await admin.from("earn360_videos").delete().eq("id", videoId).eq("active", false);
      if (error) throw error;
      return reply({ success: true });
    }

    if (path === "/api/admin/payment-details" && method === "GET") {
      await requireAdmin(profile);
      const row = await one(admin.from("earn360_settings").select("value").eq("key", "payment_details").maybeSingle());
      return reply({ payment_details: row?.value || { paypal_email: "", instructions: "" } });
    }

    if (path === "/api/admin/payment-details" && method === "PATCH") {
      await requireAdmin(profile);
      const email = String(body.paypal_email || "").trim();
      const instructions = String(body.instructions || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid PayPal receiving email.");
      const { error } = await admin.from("earn360_settings").upsert({ key: "payment_details", value: { paypal_email: email, instructions: instructions.slice(0, 1000) }, updated_at: new Date().toISOString(), updated_by: u });
      if (error) throw error;
      return reply({ message: "PayPal receiving details saved." });
    }

    if (path === "/api/admin/deposits/review" && method === "POST") {
      await requireAdmin(profile);
      const { data, error } = await admin.rpc("earn360_review_deposit", { p_admin_id: u, p_deposit_id: String(body.deposit_id || ""), p_action: String(body.action || ""), p_admin_note: String(body.admin_note || "") });
      if (error) throw error;
      return reply({ message: data.status === "approved" ? "Deposit verified and processed." : "Deposit rejected.", result: data });
    }

    if (path === "/api/admin/withdrawals/review" && method === "POST") {
      await requireAdmin(profile);
      const { data, error } = await admin.rpc("earn360_review_withdrawal", { p_admin_id: u, p_withdrawal_id: String(body.withdrawal_id || ""), p_action: String(body.action || ""), p_payout_reference: String(body.payout_reference || ""), p_admin_note: String(body.admin_note || "") });
      if (error) throw error;
      return reply({ message: data.status === "paid" ? "Payout recorded as sent." : "Withdrawal rejected and wallet refunded.", result: data });
    }

    if (path === "/api/admin/activities/review" && method === "POST") {
      await requireAdmin(profile);
      const { data, error } = await admin.rpc("earn360_review_activity_submission", { p_admin_id: u, p_submission_id: String(body.submission_id || ""), p_action: String(body.action || ""), p_admin_note: String(body.admin_note || "") });
      if (error) throw error;
      return reply({ message: data.status === "approved" ? "Activity approved and reward credited." : "Activity rejected.", result: data });
    }

    return fail("Endpoint not found.", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("Earn360 API error:", message);
    const status = /session|log in|administrator/i.test(message) ? 401 : 400;
    return fail(message, status);
  }
});
