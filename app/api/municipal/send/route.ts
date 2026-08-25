import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";

interface ReportForSend {
  public_id: string;
  reporter_email: string | null;
  municipal_email_subject: string | null;
  municipal_email_body: string | null;
  municipal_submission_status: string | null;
}

async function markFailed(supabase: SupabaseClient, publicId: string): Promise<void> {
  const { error } = await supabase
    .from("reports")
    .update({ municipal_submission_status: "failed" })
    .eq("public_id", publicId);

  if (error) {
    console.error(`Failed to mark report ${publicId} as failed:`, error);
  }
}

export async function POST(request: Request) {
  const municipalSendSecret = process.env.MUNICIPAL_SEND_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!municipalSendSecret || authHeader !== `Bearer ${municipalSendSecret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  // ---------------------------------------------------------------------
  // PRIMARY SAFETY GATE -- do not remove or weaken without explicit,
  // confirmed written approval from the City of Toronto to send email
  // programmatically to 311. As of this code being written, that approval
  // has been requested but NOT granted (Open311's write API is dead; email
  // is the only remaining channel, and using it programmatically requires
  // the City's sign-off). This check runs before request-body parsing and
  // before anything that could reach the Resend fetch call below, so a
  // caller can never reach a send attempt -- even with a valid secret --
  // unless a human has deliberately set MUNICIPAL_SEND_ENABLED=true in the
  // deployment environment.
  // ---------------------------------------------------------------------
  if (process.env.MUNICIPAL_SEND_ENABLED !== "true") {
    return Response.json(
      {
        error:
          "Municipal email sending is disabled. Programmatic submission to the City has not been approved.",
      },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null) {
    return Response.json(
      { error: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  const { public_id } = body as Record<string, unknown>;
  if (typeof public_id !== "string" || public_id === "") {
    return Response.json(
      { error: "public_id is required and must be a non-empty string." },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  const { data, error: fetchError } = await supabase
    .from("reports")
    .select("public_id, reporter_email, municipal_email_subject, municipal_email_body, municipal_submission_status")
    .eq("public_id", public_id)
    .maybeSingle();

  if (fetchError) {
    console.error(`Failed to load report ${public_id} for municipal send:`, fetchError);
    return Response.json({ error: "Failed to load report." }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "Report not found." }, { status: 404 });
  }

  const report = data as ReportForSend;

  if (report.municipal_submission_status === "sent") {
    return Response.json(
      { error: "This report has already been sent to the municipality." },
      { status: 409 }
    );
  }

  if (!report.municipal_email_subject || !report.municipal_email_body) {
    return Response.json(
      { error: "This report has no composed municipal email to send." },
      { status: 400 }
    );
  }

  const toEmail = process.env.MUNICIPAL_TO_EMAIL;
  const fromEmail = process.env.MUNICIPAL_FROM_EMAIL;
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!toEmail || !fromEmail || !resendApiKey) {
    console.error(
      "Municipal send is not fully configured: MUNICIPAL_TO_EMAIL, MUNICIPAL_FROM_EMAIL, and RESEND_API_KEY must all be set."
    );
    return Response.json(
      { error: "Municipal send is not fully configured." },
      { status: 500 }
    );
  }

  let resendResponse: Response;
  try {
    resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: report.municipal_email_subject,
        text: report.municipal_email_body,
        ...(report.reporter_email ? { reply_to: report.reporter_email } : {}),
      }),
    });
  } catch (sendError) {
    console.error(`Municipal email send threw for report ${report.public_id}:`, sendError);
    await markFailed(supabase, report.public_id);
    return Response.json({ error: "Failed to send email." }, { status: 502 });
  }

  let resendPayload: unknown;
  try {
    resendPayload = await resendResponse.json();
  } catch {
    resendPayload = null;
  }

  // Only a 2xx response carrying a provider-assigned message id counts as
  // confirmed success -- never mark a report `sent` on an unconfirmed or
  // errored response, per the project's rule that a report must never
  // claim to have reached Toronto unless it actually did.
  const confirmedSuccess =
    resendResponse.ok &&
    typeof resendPayload === "object" &&
    resendPayload !== null &&
    typeof (resendPayload as { id?: unknown }).id === "string";

  if (!confirmedSuccess) {
    console.error(
      `Municipal email send not confirmed for report ${report.public_id}: status=${resendResponse.status} body=${JSON.stringify(resendPayload)}`
    );
    await markFailed(supabase, report.public_id);
    return Response.json(
      { error: "Email provider did not confirm success." },
      { status: 502 }
    );
  }

  const { error: sentUpdateError } = await supabase
    .from("reports")
    .update({
      municipal_submission_status: "sent",
      municipal_sent_at: new Date().toISOString(),
    })
    .eq("public_id", report.public_id);

  if (sentUpdateError) {
    console.error(
      `Email sent for report ${report.public_id} but failed to update its status:`,
      sentUpdateError
    );
  }

  return Response.json({ status: "sent" }, { status: 200 });
}
