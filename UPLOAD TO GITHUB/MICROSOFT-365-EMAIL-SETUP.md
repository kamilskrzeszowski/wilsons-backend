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

   > **Shortcut (19 Jul 2026):** your tenant ID is already known from the Ops App setup —
   > **`a9eaa2ac-e047-416d-b86a-7c9ca739fa6c`**. It should match what the Overview page shows;
   > glance at it to confirm, then you only need to copy the *Application (client) ID*.

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
  mailbox in the tenant. Lock the app down to *only* the `MAIL_FROM` mailbox — **full step-by-step
  instructions for a Mac are at the bottom of this file** (“Locking HQ to one mailbox”).
- **Secret expiry:** the client secret expires (24 months above). Before it does, create a new one
  (step 2.1) and update `GRAPH_CLIENT_SECRET` in Railway. Emails stop if it lapses — the panel will say
  sign-in failed.
- **No new accounts or licences** are needed. This uses your existing Microsoft 365.

## What’s built now vs. next

- **Now (v25):** send-from-HQ works; assigning a task emails the assignee; per-person email addresses;
  status/test/pause panel.
- **Next (same stage):** a daily “what’s on your plate” reminder email; then reading a shared Outlook
  inbox to turn emails into tasks (adds the `Mail.Read` permission above).

---

# Locking HQ to one mailbox (optional security step) — step by step on a Mac

**What this does, in one sentence:** right now the Wilsons HQ app is allowed to send email as *any*
mailbox in your company; this locks it to *only* the one address it's supposed to use.

**Do you have to?** No. Email already works without it. This is a "close the door behind you" step.
It takes about 15 minutes, most of which is an installer running.

**You need two things to hand:**
1. The **Application (client) ID** from the Wilsons HQ app registration
   (Entra → App registrations → Wilsons HQ → Overview).
2. The **send-from address** you put in Railway as `MAIL_FROM` (e.g. `hq@wilsonspetfood.co.uk`).

---

## Step 1 — Install PowerShell (a free Microsoft app)

macOS doesn't come with PowerShell, so we install it once. It's a normal Mac installer.

1. Go to: **https://github.com/PowerShell/PowerShell/releases/latest**
2. Scroll down to the list of files (**Assets**).
3. Download the one ending in **`-osx-x64.pkg`**
   *(x64 = Intel Mac, which is what you have. Ignore the `arm64` one.)*
4. Double-click the downloaded file and click through the installer (Continue → Install).
5. When it says the installation was successful, close it.

## Step 2 — Open PowerShell

1. Open **Terminal** (press ⌘+Space, type `Terminal`, press Enter).
2. Type this and press Enter:
   ```
   pwsh
   ```
3. The prompt changes to `PS >`. **You're in PowerShell now.** Everything below goes in this window.

## Step 3 — Put in your two values (do this once)

Type these two lines, replacing the bits in quotes with your own values, pressing Enter after each.
*Everything after this step is pure copy-paste — nothing more to edit.*

```powershell
$AppId = "paste-your-Application-client-ID-here"
```
```powershell
$Mailbox = "your-MAIL_FROM-address@wilsonspetfood.co.uk"
```

## Step 4 — Install the Microsoft email tools

Copy-paste this line, press Enter:

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser -Force
```

It may ask about an "untrusted repository" — type **Y** and press Enter. It takes a minute or two
and prints a progress bar. That's normal.

## Step 5 — Sign in to Microsoft

Copy-paste, press Enter:

```powershell
Connect-ExchangeOnline
```

A browser window opens. Sign in with your **Microsoft 365 admin** account. When it says you can
close the window, close it and go back to Terminal.

## Step 6 — Lock it down

Copy-paste, press Enter:

```powershell
New-ApplicationAccessPolicy -AppId $AppId -PolicyScopeGroupId $Mailbox -AccessRight RestrictAccess -Description "Wilsons HQ - restrict to HQ mailbox only"
```

You'll see a few lines of confirmation. That's the lock applied.

## Step 7 — Check it actually worked

**Test A — the HQ mailbox should be ALLOWED.** Copy-paste:

```powershell
Test-ApplicationAccessPolicy -AppId $AppId -Identity $Mailbox
```
Look for **AccessCheckResult : Granted** ✅

**Test B — everyone else should be BLOCKED.** Replace the address with any *other* real person at
your company, then press Enter:

```powershell
Test-ApplicationAccessPolicy -AppId $AppId -Identity "someone.else@wilsonspetfood.co.uk"
```
Look for **AccessCheckResult : Denied** ✅

Two ticks = the lock is working exactly as intended.

## Step 8 — Confirm HQ still sends

Wilsons HQ → **Users** → Email panel → **Send test email** → check it arrives.

> ⏳ **If it fails right after step 6, don't panic.** Microsoft can take up to **30 minutes** to apply
> the policy everywhere. Wait, then try again before assuming anything's broken.

## When you're finished

Type this to sign out cleanly, then close Terminal:

```powershell
Disconnect-ExchangeOnline -Confirm:$false
```

---

### If you ever want to undo it

```powershell
Remove-ApplicationAccessPolicy -Identity <the policy identity shown in step 6>
```

---

# Phase 4 addendum — adding mailbox read access (Mail.Read)

**What this does, in one sentence:** adds permission for Wilsons HQ to *read* your inbox (for the
email → task feature), reusing the exact same registration and lockdown you already have — no new
app, no new PowerShell setup.

**Why there's no new lockdown step:** the Application Access Policy from Step 6 above restricts the
**app + mailbox pair**, not one specific permission. Once it's in place it covers *every* Graph mail
permission that app is ever granted — Send, Read, anything — for that one mailbox only. Adding
`Mail.Read` doesn't widen the door you already locked; it just gives the app a second key that only
opens that same door.

## Step 1 — Add the permission in Entra

1. Go to **entra.microsoft.com** → **App registrations** → **Wilsons HQ** → **API permissions**.
2. **Add a permission** → **Microsoft Graph** → **Application permissions**.
3. Search **`Mail.Read`**, tick it, **Add permissions**.
4. Click **Grant admin consent for [your organisation]** → **Yes**.
5. Confirm the row now shows a green tick under **Status**, same as `Mail.Send`.

## Step 2 — Prove the existing lock still covers it

Open Terminal → type `pwsh` → then run the same check as before (set `$AppId` and `$Mailbox` again
if you closed the window — see Step 3 near the top of this doc):

```powershell
Connect-ExchangeOnline
```
```powershell
Test-ApplicationAccessPolicy -AppId $AppId -Identity $Mailbox
```

Look for **AccessCheckResult : Granted** ✅ — the same result as before, now proven to hold for the
new permission too, not just Send. No second policy to create.

```powershell
Disconnect-ExchangeOnline -Confirm:$false
```

## Done

Once Step 1 shows the green tick and Step 2 says **Granted**, Phase 4 is unblocked — just say so and
it's ready to build whenever you want.
Or just ask Claude — it can look up the exact command with you.
