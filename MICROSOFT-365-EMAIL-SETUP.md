# Connecting Wilsons HQ to Microsoft 365 email

**What this does:** lets Wilsons HQ send emails through your own Microsoft 365 — starting with a
note to a colleague when you assign them a Planning task, then (next) daily reminders.

**Who needs to do this:** someone who is a **Microsoft 365 / Entra (Azure AD) administrator** at
Wilsons. If that’s not you, this is the page to forward to your IT person — it’s a standard,
one-time “app registration”. It takes about 15 minutes and costs nothing.

**Important:** one value you’ll create (the “client secret”) is a password. Only ever paste it into
**Railway** (step 3). Never put it in an email, a chat, or a document. Claude never sees it — the app
just reads it from Railway.

---

## The idea in one line

You register HQ as an “app” inside Microsoft 365, give it permission to **send mail**, and paste the
three ID/secret values (plus the address to send from) into Railway. HQ then sends email as itself —
no one has to stay signed in, and there’s no per-person login.

---

## Step 1 — Register HQ in Microsoft 365

1. Go to **https://entra.microsoft.com** and sign in as a Microsoft 365 admin.
   (The old address **https://portal.azure.com → Azure Active Directory** works too.)
2. In the left menu: **Identity → Applications → App registrations** → click **+ New registration**.
3. Name it **`Wilsons HQ`**.
4. Under *Supported account types* choose **“Accounts in this organizational directory only
   (Single tenant)”**.
5. Leave *Redirect URI* blank. Click **Register**.
6. You’re now on the app’s **Overview** page. Copy these two values somewhere safe (they’re not secret):
   - **Application (client) ID**  → this becomes `GRAPH_CLIENT_ID`
   - **Directory (tenant) ID**    → this becomes `GRAPH_TENANT_ID`

## Step 2 — Create the secret and grant “send mail”

1. Left menu of the app → **Certificates & secrets** → **+ New client secret**.
   - Description: `Wilsons HQ`  ·  Expires: **24 months** (put a reminder to renew before then).
   - Click **Add**, then **immediately copy the `Value`** (not the “Secret ID”). It’s only shown once.
     → this becomes `GRAPH_CLIENT_SECRET`.
2. Left menu → **API permissions** → **+ Add a permission** → **Microsoft Graph** →
   **Application permissions** → search **`Mail.Send`** → tick it → **Add permissions**.
3. Back on the API permissions page, click **“Grant admin consent for Wilsons…”** and confirm.
   You should see a green tick next to `Mail.Send`.

   *(Later, for pulling emails in from Outlook, you’ll add `Mail.Read` the same way. Not needed yet.)*

## Step 3 — Choose the “from” address and add the settings to Railway

1. Decide which mailbox HQ should **send from** — e.g. a shared mailbox like
   `hq@wilsonspetfood.co.uk` or `noreply@wilsonspetfood.co.uk`. It must be a real mailbox in your
   Microsoft 365. → this becomes `MAIL_FROM`.
2. In **Railway**, open the Wilsons backend service → **Variables** tab → add these (New Variable):

   | Name                  | Value                                             |
   |-----------------------|---------------------------------------------------|
   | `GRAPH_TENANT_ID`     | the Directory (tenant) ID from step 1             |
   | `GRAPH_CLIENT_ID`     | the Application (client) ID from step 1           |
   | `GRAPH_CLIENT_SECRET` | the secret **Value** from step 2                  |
   | `MAIL_FROM`           | the send-from address, e.g. hq@wilsonspetfood.co.uk |
   | `APP_URL`             | your live HQ address, e.g. https://…railway.app (makes the “Open Planning” buttons work) |

3. Railway will redeploy automatically. Wait for it to finish.

## Step 4 — Test it from inside HQ

1. In Wilsons HQ, sign in as an admin → open **Users**.
2. The **“Email (Microsoft 365)”** panel at the top should now say **Ready** (green).
3. Put your own address in the box → **Send test email** → check your inbox. A “It works! ✅” email
   should arrive within a minute.
4. Add email addresses to your staff (Users → Edit → *Email*). From then on, assigning a Planning
   task to someone emails them automatically.

If the test fails, the panel shows the exact reason (usually a mistyped value or admin consent not
granted). Fix and try again — nothing else in the app is affected.

---

## Good to know

- **Turning it off:** the Users → Email panel has a **“Pause all emails”** switch. Flip it any time to
  stop all sending immediately, without touching Railway.
- **Least privilege (optional, recommended):** by default a `Mail.Send` app permission can send as any
  mailbox in the tenant. Your IT can lock the app down to *only* the `MAIL_FROM` mailbox with an
  **Application Access Policy** (a short PowerShell command — `New-ApplicationAccessPolicy`). Ask your
  IT person if you want this; it’s a security nicety, not required to work.
- **Secret expiry:** the client secret expires (24 months above). Before it does, create a new one
  (step 2.1) and update `GRAPH_CLIENT_SECRET` in Railway. Emails stop if it lapses — the panel will say
  sign-in failed.
- **No new accounts or licences** are needed. This uses your existing Microsoft 365.

## What’s built now vs. next

- **Now (v25):** send-from-HQ works; assigning a task emails the assignee; per-person email addresses;
  status/test/pause panel.
- **Next (same stage):** a daily “what’s on your plate” reminder email; then reading a shared Outlook
  inbox to turn emails into tasks (adds the `Mail.Read` permission above).
