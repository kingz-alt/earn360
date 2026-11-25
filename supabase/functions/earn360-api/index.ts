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

function normalizeTaskAnswer(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
async function uploadTrainingAsset(userId: string, base64: string, mime: string, filename: string) {
  const allowed: Record<string,string> = {
    "image/jpeg":"jpg","image/png":"png","image/webp":"webp",
    "audio/mpeg":"mp3","audio/mp4":"m4a","audio/wav":"wav","audio/ogg":"ogg","audio/webm":"webm"
  };
  if (!allowed[mime]) throw new Error("Use JPG, PNG, WEBP, MP3, M4A, WAV, OGG or WEBM media.");
  if (typeof base64 !== "string" || base64.length > 11_000_000) throw new Error("Training media file is too large.");
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Training media must be 8 MB or smaller.");
  const path = "ai-training/" + userId + "/" + crypto.randomUUID() + "-" + safeName(filename || ("task." + allowed[mime]));
  const { error } = await admin.storage.from("earn360-private").upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw error;
  return path;
}

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
  const { data: profile, error: pErr } = await admin.from("profiles").select("id,full_name,phone,referral_code,referred_by,role,country,display_currency,preferred_language").eq("id", data.user.id).single();
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
async function countRows(query: any) {
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
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

async function requireActiveVideoMember(userId: string) {
  const membership = await getActiveMembership(userId);
  if (!membership) throw new Error("An active subscription is required to use Watch & Earn.");
  return membership;
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
    const requestPath = new URL(req.url).pathname;
    // Supabase may expose the full function prefix or only the function subpath.
    // All API endpoints begin with /api/, so extract the route from that stable boundary.
    const apiPathIndex = requestPath.lastIndexOf("/api/");
    const path = (apiPathIndex >= 0
      ? requestPath.slice(apiPathIndex)
      : requestPath.replace(/^.*\/functions\/v1\/earn360-api/, "")).replace(/\/+$/, "") || "/";
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
      const language = String(body.preferred_language || "").toLowerCase();
      if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) return fail("Choose a valid country and display currency.");
      if (!["en","fr","sw"].includes(language)) return fail("Choose English, French or Swahili as your training language.");
      const { data, error } = await admin.from("profiles").update({ country, display_currency: currency, preferred_language: language }).eq("id", u).select("country,display_currency,preferred_language").single();
      if (error) throw error;
      const today = dateInLome();
      const todayAssignments = await one(admin.from("earn360_ai_task_assignments").select("id,status").eq("user_id",u).eq("assigned_date",today));
      const alreadyStarted = (todayAssignments || []).some((x: any) => x.status === "approved");
      if (!alreadyStarted) {
        await admin.from("earn360_ai_task_assignments").delete().eq("user_id",u).eq("assigned_date",today);
        await admin.rpc("earn360_assign_daily_ai_training_tasks");
      }
      return reply({ message: alreadyStarted ? "Preferences updated. Your new training language will apply to your next daily task set." : "Preferences updated. Your daily tasks now use the selected language.", member: data });
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


    if (method === "GET" && path === "/api/ai-training/today") {
      const day = dateInLome();
      const sub = await getActiveMembership(u);
      if (!sub) return reply({ active: false, activity_completed: false, message: "Activate a subscription to unlock daily AI Training tasks.", tasks: [] });
      if (!isWeekday(day)) return reply({ active: true, activity_completed: false, message: "AI Training rewards are available Monday to Friday.", tasks: [] });
      const existing = await one(admin.from("earn360_ai_task_assignments").select("id").eq("user_id", u).eq("assigned_date", day).limit(1));
      if (!existing?.length) await admin.rpc("earn360_assign_daily_ai_training_tasks");
      const rows = await one(admin.from("earn360_ai_task_assignments")
        .select("id,status,assigned_date,task:earn360_ai_tasks(id,task_type,language_code,title,instructions,prompt,audio_text,options,asset_path,asset_mime)")
        .eq("user_id", u).eq("assigned_date", day).order("created_at", { ascending: true }));
      const tasks = [];
      for (const row of rows || []) {
        const t = row.task;
        if (!t) continue;
        tasks.push({
          assignment_id: row.id, status: row.status, task_type: t.task_type,
          title: t.title, instructions: t.instructions, prompt: t.prompt, audio_text: t.audio_text || null,
          options: Array.isArray(t.options) ? t.options : [],
          asset_url: t.asset_path ? await signedEvidence(t.asset_path) : null,
          asset_mime: t.asset_mime || null, language_code: t.language_code || "en"
        });
      }
      const completed = tasks.filter((x: any) => x.status === "approved").length;
      const reward = Number(sub.membership_plans?.weekly_reward_usd || 0) / 5;
      return reply({
        active: true, preferred_language: tasks[0]?.language_code || profile.preferred_language || "en", activity_completed: tasks.length > 0 && completed === tasks.length,
        message: tasks.length ? (completed === tasks.length ? "You completed today's AI Training tasks." : "Complete your simple daily AI Training tasks to earn today's reward.") : "Daily tasks are being prepared. Please check again shortly.",
        activity_label: "AI Training", tasks_required: tasks.length, tasks_completed: completed,
        progress_percent: tasks.length ? Math.round(completed / tasks.length * 100) : 0,
        reward_display: "$" + reward.toFixed(2), tasks
      });
    }

    if (method === "POST" && path === "/api/ai-training/submit") {
      const day = dateInLome();
      const sub = await getActiveMembership(u);
      if (!sub) return fail("An active subscription is required for AI Training.");
      if (!isWeekday(day)) return fail("AI Training rewards are available Monday to Friday.");
      const assignmentId = String(body.assignment_id || "");
      const answer = String(body.answer || "").trim();
      if (!assignmentId || !answer || answer.length > 300) return fail("Choose or enter your answer first.");
      const assignment = await one(admin.from("earn360_ai_task_assignments")
        .select("id,status,task:earn360_ai_tasks(expected_answer)")
        .eq("id", assignmentId).eq("user_id", u).eq("assigned_date", day).maybeSingle());
      if (!assignment?.task) return fail("This task is not assigned to your account today.");
      if (assignment.status === "approved") {
        const { data: rewardResult, error: rewardError } = await admin.rpc("earn360_award_ai_training_day", { p_user_id: u, p_earning_date: day });
        if (rewardError) throw rewardError;
        return reply({ correct: true, message: rewardResult?.completed ? "This task is already completed. Your daily reward is confirmed." : "This task is already completed.", day_completed: !!rewardResult?.completed, reward_amount: rewardResult?.reward_amount || 0 });
      }
      const correct = normalizeTaskAnswer(answer) === normalizeTaskAnswer(assignment.task.expected_answer);
      if (!correct) return reply({ correct: false, message: "Not quite. Try again — this task is designed to be easy." });
      const { error } = await admin.from("earn360_ai_task_assignments").update({
        status: "approved", submitted_answer: answer, submitted_at: new Date().toISOString(), checked_at: new Date().toISOString()
      }).eq("id", assignmentId).eq("user_id", u);
      if (error) throw error;
      const { data: rewardResult, error: rewardError } = await admin.rpc("earn360_award_ai_training_day", { p_user_id: u, p_earning_date: day });
      if (rewardError) throw rewardError;
      return reply({
        correct: true, message: rewardResult?.completed ? "Correct! You finished today's AI Training and your daily reward has been credited." : "Correct! Task completed.",
        day_completed: !!rewardResult?.completed, reward_amount: rewardResult?.reward_amount || 0
      });
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
      const [memberCount, pendingDeposits, pendingWithdrawals, activeSubs, depositRows, withdrawalRows] = await Promise.all([
        countRows(admin.from("profiles").select("id", { count: "exact", head: true })),
        countRows(admin.from("deposits").select("id", { count: "exact", head: true }).eq("status", "pending")),
        countRows(admin.from("withdrawal_requests").select("id", { count: "exact", head: true }).eq("status", "pending")),
        countRows(admin.from("memberships").select("id", { count: "exact", head: true }).eq("status", "active")),
        one(admin.from("deposits").select("id,user_id,amount,currency,payment_method,transaction_id,proof_url,purpose,status,created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(50)),
        one(admin.from("withdrawal_requests").select("id,user_id,amount,fee,net_amount,payment_method,account_details,status,created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(50)),
      ]);
      const ids = [...new Set([...(depositRows || []).map((x: any) => x.user_id), ...(withdrawalRows || []).map((x: any) => x.user_id)])];
      const profiles = ids.length ? await one(admin.from("profiles").select("id,full_name").in("id", ids)) : [];
      const names = new Map((profiles || []).map((x: any) => [x.id, x.full_name]));
      const queue = [];
      for (const x of depositRows || []) queue.push({ id: x.id, type: "Deposit", title: "PayPal payment", member: names.get(x.user_id) || "Member", purpose: x.purpose, external_reference: x.transaction_id, created_at: x.created_at, status: x.status, evidence_signed_url: await signedEvidence(x.proof_url) });
      const withdrawal_queue = (withdrawalRows || []).map((x: any) => ({ id: x.id, member: names.get(x.user_id) || "Member", member_email: "", gross_usd: Number(x.amount), fee_usd: Number(x.fee), net_usd: Number(x.net_amount), payout_method: x.payment_method, payout_reference: x.account_details, created_at: x.created_at }));
      return reply({ member_count: memberCount || 0, pending_deposits: pendingDeposits || 0, pending_withdrawals: pendingWithdrawals || 0, active_subscriptions: activeSubs || 0, queue, withdrawal_queue });
    }

    if (path === "/api/admin/ai-training/tasks" && method === "GET") {
      await requireAdmin(profile);
      const rows = await one(admin.from("earn360_ai_tasks").select("id,task_type,language_code,title,instructions,prompt,audio_text,options,expected_answer,asset_path,asset_mime,active,created_at").order("created_at", { ascending: false }));
      const tasks = [];
      for (const t of rows || []) tasks.push({ ...t, asset_signed_url: t.asset_path ? await signedEvidence(t.asset_path) : null });
      const setting = await one(admin.from("earn360_settings").select("value").eq("key","ai_training").maybeSingle());
      return reply({ tasks, settings: setting?.value || { daily_task_count: 5, auto_publish: true, auto_check: true, easy_mode: true } });
    }

    if (path === "/api/admin/ai-training/tasks" && method === "POST") {
      await requireAdmin(profile);
      const taskType = String(body.task_type || "");
      const languageCode = String(body.language_code || "en").toLowerCase();
      const allowedTypes = ["audio","image","image_labeling","text","translation"];
      if (!["en","fr","sw"].includes(languageCode)) return fail("Choose English, French or Swahili.");
      const title = String(body.title || "").trim().slice(0,120);
      const instructions = String(body.instructions || "").trim().slice(0,500);
      const prompt = String(body.prompt || "").trim().slice(0,500);
      const audioText = String(body.audio_text || "").trim().slice(0,500);
      const expected = String(body.expected_answer || "").trim().slice(0,200);
      const options = Array.isArray(body.options) ? body.options.map((x: any)=>String(x).trim().slice(0,100)).filter(Boolean).slice(0,8) : [];
      if (!allowedTypes.includes(taskType) || !title || !prompt || !expected) return fail("Complete the task type, title, question and correct answer.");
      if (options.length && !options.some((x: string)=>normalizeTaskAnswer(x)===normalizeTaskAnswer(expected))) return fail("The correct answer must be one of the answer choices.");
      let assetPath: string | null = null;
      let assetMime: string | null = null;
      if (body.asset_base64) {
        assetMime = String(body.asset_mime || "");
        assetPath = await uploadTrainingAsset(u, body.asset_base64, assetMime, String(body.asset_name || "task-media"));
      }
      if (["image","image_labeling"].includes(taskType) && !assetPath) return fail("Image tasks need an image file.");
      if (taskType === "audio" && !assetPath && !audioText) return fail("Add an audio sentence or upload an audio file.");
      if (assetPath && taskType === "audio" && !assetMime?.startsWith("audio/")) return fail("Audio tasks need an audio file.");
      if (["image","image_labeling"].includes(taskType) && !assetMime?.startsWith("image/")) return fail("Image tasks need an image file.");
      const created = await one(admin.from("earn360_ai_tasks").insert({
        task_type: taskType, language_code: languageCode, title, instructions, prompt, audio_text: audioText || null, options, expected_answer: expected,
        asset_path: assetPath, asset_mime: assetMime, active: body.active !== false
      }).select("id,task_type,title,active").single());
      return reply({ message: "AI Training task added to the task bank.", task: created }, 201);
    }

    if (path === "/api/admin/ai-training/tasks" && method === "PATCH") {
      await requireAdmin(profile);
      const taskId = String(body.task_id || "");
      if (!taskId || typeof body.active !== "boolean") return fail("Choose a task and its active status.");
      const { data, error } = await admin.from("earn360_ai_tasks").update({ active: body.active, updated_at: new Date().toISOString() }).eq("id", taskId).select("id,active").maybeSingle();
      if (error) throw error;
      if (!data) return fail("Task was not found.");
      return reply({ message: data.active ? "Task enabled for future daily assignments." : "Task disabled for future daily assignments.", task: data });
    }

    if (path === "/api/admin/ai-training/settings" && method === "PATCH") {
      await requireAdmin(profile);
      const count = Math.floor(Number(body.daily_task_count));
      if (!Number.isInteger(count) || count < 1 || count > 20) return fail("Daily task count must be between 1 and 20.");
      const value = { daily_task_count: count, auto_publish: true, auto_check: true, easy_mode: true };
      const { error } = await admin.from("earn360_settings").upsert({ key: "ai_training", value, updated_at: new Date().toISOString(), updated_by: u });
      if (error) throw error;
      return reply({ message: "AI Training settings saved.", settings: value });
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

    return fail("Endpoint not found.", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("Earn360 API error:", message);
    const status = /session|log in|administrator/i.test(message) ? 401 : 400;
    return fail(message, status);
  }
});
