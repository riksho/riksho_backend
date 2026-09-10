import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";

interface BusinessNotificationPayload {
  businessId: string;
  businessName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  city?: string;
}

/**
 * Sends a Congratulatory SMS to the newly approved business owner.
 */
export async function sendBusinessApprovalSMS(payload: BusinessNotificationPayload): Promise<{ success: boolean; simulated?: boolean }> {
  const { businessId, businessName, contactName, phone } = payload;
  if (!phone) {
    logger.warn({ businessId }, "No phone number available to send approval SMS");
    return { success: false };
  }

  const cleanPhone = phone.replace(/^\+91/, "").replace(/^0+/, "").trim();
  const formattedPhone = `+91${cleanPhone}`;
  const message = `🎉 Congratulations! Your Riksho Enterprise account for ${businessName} has been approved. Sign in at https://riksho.in/business/login to access your dashboard, book logistics & manage fleet. - Riksho Logistics`;

  let sent = false;
  let simulated = true;

  // 1. Check if Fast2SMS or external SMS API key is configured
  const fast2SmsKey = process.env.FAST2SMS_API_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

  if (fast2SmsKey) {
    try {
      const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
        method: "POST",
        headers: {
          authorization: fast2SmsKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          route: "v3",
          sender_id: "RIKSHO",
          message,
          language: "english",
          numbers: cleanPhone,
        }),
      });
      const data = await res.json();
      sent = res.ok;
      simulated = false;
      logger.info({ data, phone: formattedPhone }, "Fast2SMS dispatch result");
    } catch (err) {
      logger.error({ err, phone: formattedPhone }, "Fast2SMS request failed");
    }
  } else if (twilioSid && twilioAuth && twilioFrom) {
    try {
      const body = new URLSearchParams({
        To: formattedPhone,
        From: twilioFrom,
        Body: message,
      });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      const data = await res.json();
      sent = res.ok;
      simulated = false;
      logger.info({ data, phone: formattedPhone }, "Twilio SMS dispatch result");
    } catch (err) {
      logger.error({ err, phone: formattedPhone }, "Twilio SMS request failed");
    }
  } else {
    // Simulated development dispatch
    sent = true;
    simulated = true;
    logger.info(
      {
        to: formattedPhone,
        businessName,
        message,
      },
      "📱 [SMS DISPATCH SIMULATION] Sent Congratulatory SMS to Business Owner"
    );
  }

  // 2. Record notification in audit table
  try {
    await supabaseAdmin.from("business_notifications").insert({
      business_id: businessId,
      recipient_phone: formattedPhone,
      notification_type: "approval_sms",
      status: simulated ? "simulated" : (sent ? "sent" : "failed"),
      title: "Business Account Approved",
      message,
      payload: { businessName, contactName, phone: formattedPhone },
    });
  } catch (err) {
    logger.warn({ err }, "Could not record business SMS notification log (non-fatal)");
  }

  return { success: sent, simulated };
}

/**
 * Sends a Congratulatory Welcome Email with enterprise portal details.
 */
export async function sendBusinessApprovalEmail(payload: BusinessNotificationPayload): Promise<{ success: boolean; simulated?: boolean }> {
  const { businessId, businessName, contactName, email } = payload;
  if (!email) {
    logger.warn({ businessId }, "No email address available to send approval email");
    return { success: false };
  }

  const subject = `🎉 Welcome to Riksho Enterprise — Account Approved for ${businessName}`;
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
          .header { background: #4338CA; padding: 32px 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0 0 8px; font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
          .header p { margin: 0; font-size: 14px; opacity: 0.9; }
          .content { padding: 32px 28px; color: #1e293b; line-height: 1.6; }
          .badge { display: inline-block; padding: 6px 14px; background: #ecfdf5; color: #047857; border-radius: 999px; font-weight: 700; font-size: 13px; margin-bottom: 20px; }
          .box { background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 24px 0; }
          .box-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
          .box-item:last-child { border-bottom: none; }
          .box-label { color: #64748b; font-weight: 600; }
          .box-val { color: #0f172a; font-weight: 700; }
          .btn-container { text-align: center; margin: 32px 0 20px; }
          .btn { background: #4338CA; color: #ffffff !important; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block; }
          .footer { background: #f1f5f9; padding: 20px; text-align: center; font-size: 12px; color: #64748b; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Riksho Enterprise</h1>
            <p>On-Demand B2B Logistics & Fleet Management</p>
          </div>
          <div class="content">
            <div class="badge">✓ Application Approved</div>
            <p>Hello <strong>${contactName || "Partner"}</strong>,</p>
            <p>We are delighted to inform you that your Riksho Enterprise account for <strong>${businessName}</strong> has been officially verified and approved by our onboarding team!</p>
            
            <div class="box">
              <div class="box-item">
                <span class="box-label">Enterprise Entity:</span>
                <span class="box-val">${businessName}</span>
              </div>
              <div class="box-item">
                <span class="box-label">Registered Email:</span>
                <span class="box-val">${email}</span>
              </div>
              <div class="box-item">
                <span class="box-label">Status:</span>
                <span class="box-val" style="color: #047857;">Active / Verified</span>
              </div>
            </div>

            <p>You now have full access to:</p>
            <ul style="padding-left: 20px; color: #334155;">
              <li>Real-time booking and automated dispatch for mini-trucks, tempos, and couriers.</li>
              <li>Enterprise developer API keys and webhook integration.</li>
              <li>GST-compliant invoicing and consolidated monthly credit limits.</li>
            </ul>

            <div class="btn-container">
              <a href="https://riksho.in/business/login" class="btn">Access Business Portal →</a>
            </div>
            
            <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
              Need assistance? Reach out anytime at <a href="mailto:support@riksho.in" style="color: #4338CA;">support@riksho.in</a>.
            </p>
          </div>
          <div class="footer">
            © ${new Date().getFullYear()} Riksho Logistics Technologies Pvt. Ltd. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  let sent = false;
  let simulated = true;

  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || "Riksho Enterprise <enterprise@riksho.in>",
          to: [email],
          subject,
          html: htmlContent,
        }),
      });
      const data = await res.json();
      sent = res.ok;
      simulated = false;
      logger.info({ data, email }, "Resend email dispatch result");
    } catch (err) {
      logger.error({ err, email }, "Resend email request failed");
    }
  } else {
    // Simulated development dispatch
    sent = true;
    simulated = true;
    logger.info(
      {
        to: email,
        subject,
        businessName,
      },
      "📧 [EMAIL DISPATCH SIMULATION] Sent Congratulatory Welcome Email to Business Owner"
    );
  }

  // Record in audit table
  try {
    await supabaseAdmin.from("business_notifications").insert({
      business_id: businessId,
      recipient_email: email,
      notification_type: "approval_email",
      status: simulated ? "simulated" : (sent ? "sent" : "failed"),
      title: subject,
      message: `Account approved for ${businessName}`,
      payload: { businessName, contactName, email },
    });
  } catch (err) {
    logger.warn({ err }, "Could not record business email notification log (non-fatal)");
  }

  return { success: sent, simulated };
}
