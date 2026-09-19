require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();

/* =========================================================
   MERCADO — SERVER
   eBay catalog + GatePay.to payment gateway
   ========================================================= */

const PORT = process.env.PORT || 10000;

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://mercado-shop-zroh.onrender.com";

const GATEPAY_API = "https://api.gatepay.to/pay.php";

const GATEPAY_WALLET =
  process.env.GATEPAY_WALLET_ADDRESS ||
  "0xB7414134da31fE43473bA28c38dDfc825BE021eE";

const GATEPAY_CURRENCY =
  process.env.GATEPAY_CURRENCY || "EUR";

/*
  IMPORTANT:
  This is the MERCADO markup.
  Customer only sees the final price.
*/
const PRICE_MARKUP = Number(process.env.PRICE_MARKUP || 6);

const EBAY_ENVIRONMENT =
  process.env.EBAY_ENVIRONMENT || "production";

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

const ADMIN_KEY = process.env.ADMIN_KEY || "";

const DATA_DIR = path.join(__dirname, "data");

const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const REVIEWS_FILE = path.join(DATA_DIR, "reviews.json");
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");
const VIEWS_FILE = path.join(DATA_DIR, "product-views.json");

/* =========================================================
   BASIC CONFIG
   ========================================================= */

app.use(cors({
  origin: process.env.CORS_ORIGIN || "*"
}));

app.use(express.json({ limit: "2mb" }));

app.use(express.urlencoded({
  extended: true,
  limit: "2mb"
}));

app.set("trust proxy", 1);

/* =========================================================
   DATA HELPERS
   ========================================================= */

function ensureDataFile(file, fallback = []) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(fallback, null, 2),
        "utf8"
      );
    }
  } catch (err) {
    console.error("DATA FILE ERROR:", err.message);
  }
}

function readJson(file, fallback = []) {
  try {
    ensureDataFile(file, fallback);

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch (err) {
    console.error("READ JSON ERROR:", file, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    ensureDataFile(file, []);

    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );

    return true;
  } catch (err) {
    console.error("WRITE JSON ERROR:", file, err.message);
    return false;
  }
}

ensureDataFile(ORDERS_FILE, []);
ensureDataFile(PRODUCTS_FILE, []);
ensureDataFile(REVIEWS_FILE, []);
ensureDataFile(SUBSCRIBERS_FILE, []);
ensureDataFile(VIEWS_FILE, []);

/* =========================================================
   UTILS
   ========================================================= */

function cleanString(value, max = 500) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function money(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function makeId(prefix = "M") {
  return (
    prefix +
    "-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

function getBaseUrl() {
  return String(PUBLIC_BASE_URL || "")
    .replace(/\/+$/, "");
}

/* =========================================================
   EMAIL
   ========================================================= */

let mailTransporter = null;

if (process.env.RESEND_API_KEY) {
  /*
    Resend can be integrated through HTTP/API.
    The current server keeps SMTP fallback below.
  */
}

if (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure:
      String(process.env.SMTP_SECURE || "false")
        .toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendEmail(to, subject, html) {
  if (!mailTransporter || !to) {
    return false;
  }

  try {
    await mailTransporter.sendMail({
      from:
        process.env.SMTP_FROM ||
        process.env.SMTP_USER,
      to,
      subject,
      html
    });

    return true;
  } catch (err) {
    console.error("EMAIL ERROR:", err.message);
    return false;
  }
}

/* =========================================================
   EMAIL VERIFICATION
   ========================================================= */

const emailCodes = new Map();

app.post("/api/email/send", async (req, res) => {
  try {
    const email = cleanString(req.body.email, 200)
      .toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid email"
      });
    }

    const code =
      Math.floor(1000 + Math.random() * 9000)
        .toString();

    emailCodes.set(email, {
      code,
      expires:
        Date.now() + 10 * 60 * 1000
    });

    await sendEmail(
      email,
      "MERCADO email verification",
      `
        <div style="font-family:Arial,sans-serif">
          <h2>MERCADO</h2>
          <p>Your verification code is:</p>
          <h1>${code}</h1>
          <p>This code expires in 10 minutes.</p>
        </div>
      `
    );

    return res.json({
      ok: true
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      ok: false,
      error: "Unable to send verification code"
    });
  }
});

app.post("/api/email/verify", (req, res) => {
  try {
    const email = cleanString(req.body.email, 200)
      .toLowerCase();

    const code = cleanString(req.body.code, 20);

    const record = emailCodes.get(email);

    if (!record) {
      return res.status(400).json({
        ok: false,
        error: "Code not found"
      });
    }

    if (Date.now() > record.expires) {
      emailCodes.delete(email);

      return res.status(400).json({
        ok: false,
        error: "Code expired"
      });
    }

    if (record.code !== code) {
      return res.status(400).json({
        ok: false,
        error: "Invalid code"
      });
    }

    emailCodes.delete(email);

    return res.json({
      ok: true,
      verified: true
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Verification failed"
    });
  }
});

/* =========================================================
   eBay OAuth
   ========================================================= */

let ebayToken = null;
let ebayTokenExpires = 0;

function ebayApiBase() {
  if (EBAY_ENVIRONMENT === "sandbox") {
    return "https://api.sandbox.ebay.com";
  }

  return "https://api.ebay.com";
}

function ebayOAuthUrl() {
  if (EBAY_ENVIRONMENT === "sandbox") {
    return "https://api.sandbox.ebay.com/identity/v1/oauth2/token";
  }

  return "https://api.ebay.com/identity/v1/oauth2/token";
}

async function getEbayToken() {
  if (
    ebayToken &&
    Date.now() < ebayTokenExpires - 60 * 1000
  ) {
    return ebayToken;
  }

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("eBay credentials are not configured");
  }

  const credentials =
    Buffer.from(
      `${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`
    ).toString("base64");

  const response = await fetch(ebayOAuthUrl(), {
    method: "POST",

    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type":
        "application/x-www-form-urlencoded"
    },

    body:
      "grant_type=client_credentials&scope=" +
      encodeURIComponent(
        "https://api.ebay.com/oauth/api_scope"
      )
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("eBay OAuth:", data);

    throw new Error(
      "Unable to authenticate with eBay"
    );
  }

  ebayToken = data.access_token;

  ebayTokenExpires =
    Date.now() +
    Number(data.expires_in || 7200) * 1000;

  return ebayToken;
}

/* =========================================================
   eBay SEARCH
   ========================================================= */

async function ebaySearch({
  query = "popular products",
  limit = 48,
  offset = 0
} = {}) {

  const token = await getEbayToken();

  const safeLimit = Math.min(
    Math.max(Number(limit) || 48, 1),
    200
  );

  const safeOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const params = new URLSearchParams();

  params.set(
    "q",
    cleanString(query, 200) || "popular products"
  );

  params.set(
    "limit",
    String(safeLimit)
  );

  params.set(
    "offset",
    String(safeOffset)
  );

  params.set(
    "filter",
    "buyingOptions:{FIXED_PRICE}"
  );

  const url =
    ebayApiBase() +
    "/buy/browse/v1/item_summary/search?" +
    params.toString();

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID":
        "EBAY_US"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(
      "eBay SEARCH ERROR:",
      response.status,
      data
    );

    throw new Error(
      "eBay catalog request failed"
    );
  }

  return data;
}

/* =========================================================
   PRICE
   ========================================================= */

function mercadoPrice(ebayPrice) {
  const base = money(ebayPrice);

  if (base <= 0) return 0;

  /*
    The $6 markup is added here.
    It is NOT returned separately to customers.
  */

  return money(base + PRICE_MARKUP);
}

/* =========================================================
   NORMALIZE eBay ITEM
   ========================================================= */

function normalizeEbayItem(item) {
  const ebayPrice = money(
    item?.price?.value
  );

  const finalPrice =
    mercadoPrice(ebayPrice);

  return {
    id:
      item.itemId ||
      item.legacyItemId ||
      makeId("EB"),

    name:
      item.title ||
      "Product",

    price:
      finalPrice,

    currency:
      item?.price?.currency ||
      "USD",

    image:
      item?.image?.imageUrl ||
      item?.thumbnailImages?.[0]?.imageUrl ||
      "",

    images:
      Array.isArray(item?.additionalImages)
        ? item.additionalImages
            .map(x => x?.imageUrl)
            .filter(Boolean)
        : [],

    condition:
      item.condition ||
      "",

    category:
      item?.categories?.[0]?.categoryName ||
      "Products",

    seller:
      item?.seller?.username ||
      "",

    url:
      item.itemWebUrl ||
      "",

    shipping:
      item?.shippingOptions?.[0] || null,

    /*
      Internal fields are NOT exposed.
      Supplier price remains server-side.
    */
    _ebayItemId:
      item.itemId ||
      item.legacyItemId ||
      null,

    _ebayPrice:
      ebayPrice
  };
}

/*
  Public version.
  Removes supplier price from JSON sent to browser.
*/
function publicProduct(item) {
  const copy = {
    ...item
  };

  delete copy._ebayPrice;

  return copy;
}

/* =========================================================
   CATALOG HOME
   ========================================================= */

app.get("/api/catalog/home", async (req, res) => {
  try {
    const limit = Math.min(
      Number(req.query.limit || 48),
      200
    );

    /*
      Several queries are merged to make the home
      page much larger and more varied.
    */

    const queries = [
      "popular products",
      "best selling products",
      "trending products",
      "electronics",
      "fashion",
      "home products",
      "beauty products",
      "watches",
      "phone accessories"
    ];

    const perQuery = Math.max(
      8,
      Math.ceil(limit / queries.length)
    );

    const results = await Promise.all(
      queries.map(q =>
        ebaySearch({
          query: q,
          limit: perQuery,
          offset: 0
        })
      )
    );

    const map = new Map();

    for (const result of results) {
      for (const raw of result.itemSummaries || []) {
        const item =
          normalizeEbayItem(raw);

        if (!item.id) continue;

        if (!map.has(item.id)) {
          map.set(
            item.id,
            publicProduct(item)
          );
        }
      }
    }

    const items =
      Array.from(map.values())
        .slice(0, limit);

    res.json({
      ok: true,
      total: items.length,
      items
    });

  } catch (err) {
    console.error(
      "HOME CATALOG ERROR:",
      err.message
    );

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* =========================================================
   GLOBAL SEARCH
   ========================================================= */

app.get("/api/catalog/search", async (req, res) => {
  try {
    const query =
      cleanString(
        req.query.q ||
        req.query.query ||
        "",
        200
      );

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: "Search query required"
      });
    }

    const limit = Math.min(
      Number(req.query.limit || 48),
      200
    );

    const offset = Math.max(
      Number(req.query.offset || 0),
      0
    );

    const result =
      await ebaySearch({
        query,
        limit,
        offset
      });

    const items =
      (result.itemSummaries || [])
        .map(normalizeEbayItem)
        .map(publicProduct);

    res.json({
      ok: true,
      total:
        Number(result.total) ||
        items.length,

      offset,

      limit,

      items
    });

  } catch (err) {
    console.error(
      "SEARCH ERROR:",
      err.message
    );

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* =========================================================
   ORDER PRICE CALCULATION
   ========================================================= */

function calculateOrderTotal(items) {
  if (!Array.isArray(items)) {
    return 0;
  }

  let total = 0;

  for (const item of items) {
    const price = money(item.price);

    const qty = Math.max(
      1,
      Math.min(
        Number(item.qty || item.quantity || 1),
        99
      )
    );

    if (price <= 0) continue;

    total += price * qty;
  }

  return money(total);
}

/* =========================================================
   CREATE ORDER
   ========================================================= */

app.post("/api/order", async (req, res) => {
  try {
    const body = req.body || {};

    const items =
      Array.isArray(body.items)
        ? body.items
        : [];

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        error: "Order contains no products"
      });
    }

    /*
      IMPORTANT:
      Never trust body.total.

      Total is calculated on the server.
    */

    const total =
      calculateOrderTotal(items);

    if (total <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid order total"
      });
    }

    const orderId =
      cleanString(
        body.orderId,
        100
      ) ||
      makeId("ORD");

    const customer =
      body.customer || {};

    const order = {
      orderId,

      items: items.map(item => ({
        id:
          cleanString(item.id, 200),

        name:
          cleanString(item.name, 500),

        price:
          money(item.price),

        qty:
          Math.max(
            1,
            Number(
              item.qty ||
              item.quantity ||
              1
            )
          ),

        image:
          cleanString(
            item.image,
            1000
          ),

        url:
          cleanString(
            item.url ||
            item.sourceUrl,
            2000
          )
      })),

      customer: {
        name:
          cleanString(
            customer.name,
            200
          ),

        email:
          cleanString(
            customer.email,
            300
          ).toLowerCase(),

        phone:
          cleanString(
            customer.phone,
            100
          ),

        address:
          cleanString(
            customer.address,
            1000
          ),

        city:
          cleanString(
            customer.city,
            200
          ),

        country:
          cleanString(
            customer.country,
            200
          )
      },

      paymentMethod:
        "gatepay",

      total,

      currency:
        GATEPAY_CURRENCY,

      status:
        "pending_payment",

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()
    };

    const orders =
      readJson(
        ORDERS_FILE,
        []
      );

    orders.push(order);

    writeJson(
      ORDERS_FILE,
      orders
    );

    res.json({
      ok: true,

      order: {
        orderId,
        total,
        currency:
          GATEPAY_CURRENCY,
        status:
          order.status
      }
    });

  } catch (err) {
    console.error(
      "ORDER ERROR:",
      err.message
    );

    res.status(500).json({
      ok: false,
      error: "Unable to create order"
    });
  }
});

/* =========================================================
   FIND ORDER
   ========================================================= */

function findOrder(orderId) {
  const orders =
    readJson(
      ORDERS_FILE,
      []
    );

  return orders.find(
    x =>
      String(x.orderId) ===
      String(orderId)
  );
}

/* =========================================================
   UPDATE ORDER
   ========================================================= */

function updateOrder(orderId, patch) {
  const orders =
    readJson(
      ORDERS_FILE,
      []
    );

  const index =
    orders.findIndex(
      x =>
        String(x.orderId) ===
        String(orderId)
    );

  if (index === -1) {
    return null;
  }

  orders[index] = {
    ...orders[index],
    ...patch,
    updatedAt:
      new Date().toISOString()
  };

  writeJson(
    ORDERS_FILE,
    orders
  );

  return orders[index];
}

/* =========================================================
   GATEPAY URL EXTRACTION
   ========================================================= */

function extractGatePayUrl(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const possible = [
    data.payment_url,
    data.paymentUrl,
    data.checkout_url,
    data.checkoutUrl,
    data.url,
    data.redirect_url,
    data.redirectUrl,

    data?.data?.payment_url,
    data?.data?.paymentUrl,
    data?.data?.checkout_url,
    data?.data?.checkoutUrl,
    data?.data?.url,

    data?.result?.payment_url,
    data?.result?.paymentUrl,
    data?.result?.checkout_url,
    data?.result?.checkoutUrl,
    data?.result?.url
  ];

  return (
    possible.find(
      x =>
        typeof x === "string" &&
        /^https?:\/\//i.test(x)
    ) ||
    null
  );
}

/* =========================================================
   GATEPAY PAYMENT
   ========================================================= */

app.post(
  "/api/payment/gatepay",
  async (req, res) => {
    try {
      const orderId =
        cleanString(
          req.body.orderId ||
          req.body.order_id,
          100
        );

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "orderId is required"
        });
      }

      /*
        SECURITY:
        The amount comes from our stored order.

        We DO NOT trust:
        req.body.amount
        req.body.total
      */

      const order =
        findOrder(orderId);

      if (!order) {
        return res.status(404).json({
          ok: false,
          error: "Order not found"
        });
      }

      if (
        order.status === "paid" ||
        order.status === "completed"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Order is already paid"
        });
      }

      const amount =
        money(order.total);

      if (amount <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Invalid order amount"
        });
      }

      if (!GATEPAY_WALLET) {
        return res.status(500).json({
          ok: false,
          error:
            "GatePay wallet is not configured"
        });
      }

      const callbackUrl =
        `${getBaseUrl()}/api/payment/gatepay/callback`;

      /*
        GatePay payment request.
      */

      const payload = {
        wallet:
          GATEPAY_WALLET,

        amount,

        currency:
          GATEPAY_CURRENCY,

        callback_url:
          callbackUrl,

        order_id:
          orderId
      };

      console.log(
        "GATEPAY REQUEST:",
        {
          orderId,
          amount,
          currency:
            GATEPAY_CURRENCY
        }
      );

      const response =
        await fetch(
          GATEPAY_API,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
              "Accept":
                "application/json"
            },

            body:
              JSON.stringify(payload)
          }
        );

      const raw =
        await response.text();

      let data;

      try {
        data =
          JSON.parse(raw);
      } catch {
        data = {
          raw
        };
      }

      console.log(
        "GATEPAY RESPONSE:",
        response.status,
        data
      );

      if (!response.ok) {
        return res.status(502).json({
          ok: false,
          error:
            "GatePay payment creation failed",
          gatepay:
            data
        });
      }

      const paymentUrl =
        extractGatePayUrl(data);

      if (!paymentUrl) {
        return res.status(502).json({
          ok: false,
          error:
            "GatePay did not return a checkout URL",
          gatepay:
            data
        });
      }

      updateOrder(
        orderId,
        {
          status:
            "awaiting_payment",

          gatepay: {
            checkoutUrl:
              paymentUrl,

            createdAt:
              new Date().toISOString()
          }
        }
      );

      return res.json({
        ok: true,

        orderId,

        amount,

        currency:
          GATEPAY_CURRENCY,

        paymentUrl
      });

    } catch (err) {
      console.error(
        "GATEPAY ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          err.message ||
          "GatePay error"
      });
    }
  }
);

/* =========================================================
   PAYGATE ALIAS
   ========================================================= */

app.post(
  "/api/payment/paygate",
  async (req, res) => {

    req.url =
      "/api/payment/gatepay";

    return app._router.handle(
      req,
      res,
      () => {}
    );
  }
);

/* =========================================================
   GATEPAY CALLBACK
   ========================================================= */

/*
  IMPORTANT:
  This callback handler accepts the status/order information
  returned by GatePay.

  If GatePay provides a documented cryptographic signature
  mechanism, it should be verified here before marking an
  order as paid.
*/

app.all(
  "/api/payment/gatepay/callback",
  async (req, res) => {
    try {
      const data = {
        ...(req.query || {}),
        ...(req.body || {})
      };

      const orderId =
        cleanString(
          data.order_id ||
          data.orderId ||
          data.merchant_order_id ||
          data.merchantOrderId,
          100
        );

      if (!orderId) {
        return res.status(400).send(
          "Missing order_id"
        );
      }

      const order =
        findOrder(orderId);

      if (!order) {
        return res.status(404).send(
          "Order not found"
        );
      }

      const status =
        String(
          data.status ||
          data.payment_status ||
          data.paymentStatus ||
          data.state ||
          ""
        ).toLowerCase();

      const successStatuses = [
        "paid",
        "success",
        "successful",
        "completed",
        "confirmed",
        "complete"
      ];

      const failedStatuses = [
        "failed",
        "cancelled",
        "canceled",
        "expired",
        "declined"
      ];

      if (
        successStatuses.includes(status)
      ) {

        const updated =
          updateOrder(
            orderId,
            {
              status: "paid",

              paidAt:
                new Date().toISOString(),

              gatepayCallback:
                data
            }
          );

        /*
          Notify admin.
        */

        await notifyAdminOrder(
          updated
        );

        return res.status(200).send(
          "OK"
        );
      }

      if (
        failedStatuses.includes(status)
      ) {

        updateOrder(
          orderId,
          {
            status:
              "payment_failed",

            gatepayCallback:
              data
          }
        );

        return res.status(200).send(
          "OK"
        );
      }

      /*
        Unknown status:
        save it but don't mark as paid.
      */

      updateOrder(
        orderId,
        {
          gatepayCallback:
            data
        }
      );

      return res.status(200).send(
        "RECEIVED"
      );

    } catch (err) {
      console.error(
        "CALLBACK ERROR:",
        err
      );

      return res.status(500).send(
        "Callback error"
      );
    }
  }
);

/* =========================================================
   TELEGRAM
   ========================================================= */

async function sendTelegramMessage(
  message
) {
  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return false;
  }

  try {
    const url =
      `https://api.telegram.org/bot${token}/sendMessage`;

    const response =
      await fetch(url, {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            chat_id:
              chatId,

            text:
              message,

            parse_mode:
              "HTML",

            disable_web_page_preview:
              true
          })
      });

    return response.ok;

  } catch (err) {
    console.error(
      "TELEGRAM ERROR:",
      err.message
    );

    return false;
  }
}

async function notifyAdminOrder(order) {
  if (!order) return;

  const lines = [
    "🛒 <b>MERCADO — PAYMENT RECEIVED</b>",
    "",
    `<b>Order:</b> ${order.orderId}`,
    `<b>Total:</b> ${order.total} ${order.currency}`,
    `<b>Status:</b> PAID`,
    "",
    "<b>Customer</b>",
    `Name: ${order.customer?.name || "-"}`,
    `Email: ${order.customer?.email || "-"}`,
    `Phone: ${order.customer?.phone || "-"}`,
    `Address: ${order.customer?.address || "-"}`,
    ""
  ];

  lines.push("<b>Products</b>");

  for (const item of order.items || []) {
    lines.push(
      `• ${item.name} × ${item.qty} — ${item.price}`
    );

    if (item.url) {
      lines.push(item.url);
    }
  }

  await sendTelegramMessage(
    lines.join("\n")
  );

  if (order.customer?.email) {
    await sendEmail(
      order.customer.email,
      "MERCADO — Order confirmed",
      `
        <div style="font-family:Arial,sans-serif">
          <h2>Thank you for your order!</h2>

          <p>
            Your MERCADO order
            <strong>${order.orderId}</strong>
            has been confirmed.
          </p>

          <p>
            Total:
            <strong>
              ${order.total} ${order.currency}
            </strong>
          </p>

          <p>
            We will process your order shortly.
          </p>
        </div>
      `
    );
  }
}

/* =========================================================
   ORDER STATUS
   ========================================================= */

app.get(
  "/api/order/:orderId",
  (req, res) => {

    const order =
      findOrder(
        req.params.orderId
      );

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    /*
      Don't expose sensitive GatePay callback data.
    */

    const safe = {
      orderId:
        order.orderId,

      items:
        order.items,

      customer: {
        name:
          order.customer?.name || "",
        email:
          order.customer?.email || ""
      },

      total:
        order.total,

      currency:
        order.currency,

      status:
        order.status,

      createdAt:
        order.createdAt,

      paidAt:
        order.paidAt || null
    };

    res.json({
      ok: true,
      order: safe
    });
  }
);

/* =========================================================
   CONFIG
   ========================================================= */

app.get(
  "/api/config",
  (req, res) => {

    res.json({
      ok: true,

      payment: {
        provider:
          "GatePay",

        gatepay: true,

        currency:
          GATEPAY_CURRENCY,

        walletConfigured:
          Boolean(GATEPAY_WALLET)
      },

      catalog: {
        provider:
          "eBay",

        configured:
          Boolean(
            EBAY_CLIENT_ID &&
            EBAY_CLIENT_SECRET
          )
      },

      markup: {
        includedInPrice:
          true
      }
    });
  }
);

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,

      service:
        "MERCADO",

      status:
        "online",

      payment:
        "GatePay",

      catalog:
        "eBay",

      gatepayConfigured:
        Boolean(GATEPAY_WALLET),

      ebayConfigured:
        Boolean(
          EBAY_CLIENT_ID &&
          EBAY_CLIENT_SECRET
        ),

      publicBaseUrl:
        getBaseUrl(),

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   REVIEWS
   ========================================================= */

app.get(
  "/api/reviews",
  (req, res) => {

    const reviews =
      readJson(
        REVIEWS_FILE,
        []
      );

    res.json({
      ok: true,
      reviews
    });
  }
);

app.post(
  "/api/reviews",
  (req, res) => {

    try {
      const review = {
        id:
          makeId("REV"),

        name:
          cleanString(
            req.body.name,
            100
          ),

        email:
          cleanString(
            req.body.email,
            300
          ).toLowerCase(),

        rating:
          Math.max(
            1,
            Math.min(
              5,
              Number(
                req.body.rating || 5
              )
            )
          ),

        text:
          cleanString(
            req.body.text,
            2000
          ),

        product:
          cleanString(
            req.body.product,
            300
          ),

        createdAt:
          new Date().toISOString()
      };

      const reviews =
        readJson(
          REVIEWS_FILE,
          []
        );

      reviews.unshift(review);

      writeJson(
        REVIEWS_FILE,
        reviews.slice(0, 5000)
      );

      res.json({
        ok: true,
        review
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          "Unable to save review"
      });
    }
  }
);

/* =========================================================
   PRODUCT VIEW TRACKING
   ========================================================= */

app.post(
  "/api/track-view",
  (req, res) => {

    try {
      const email =
        cleanString(
          req.body.email,
          300
        ).toLowerCase();

      const product =
        req.body.product || {};

      if (!email || !product) {
        return res.status(400).json({
          ok: false
        });
      }

      const views =
        readJson(
          VIEWS_FILE,
          []
        );

      views.push({
        email,

        product: {
          id:
            cleanString(
              product.id,
              300
            ),

          name:
            cleanString(
              product.name,
              500
            ),

          price:
            money(product.price),

          image:
            cleanString(
              product.image,
              1000
            ),

          url:
            cleanString(
              product.url,
              2000
            )
        },

        viewedAt:
          new Date().toISOString(),

        reminded:
          false
      });

      writeJson(
        VIEWS_FILE,
        views.slice(-500)
      );

      res.json({
        ok: true
      });

    } catch (err) {
      res.status(500).json({
        ok: false
      });
    }
  }
);

/* =========================================================
   AVAILABILITY SUBSCRIPTIONS
   ========================================================= */

app.post(
  "/api/notify/subscribe",
  (req, res) => {

    try {
      const email =
        cleanString(
          req.body.email,
          300
        ).toLowerCase();

      const query =
        cleanString(
          req.body.query,
          500
        );

      if (!email || !query) {
        return res.status(400).json({
          ok: false,
          error:
            "Email and query required"
        });
      }

      const subscribers =
        readJson(
          SUBSCRIBERS_FILE,
          []
        );

      subscribers.push({
        id:
          makeId("SUB"),

        email,

        query,

        createdAt:
          new Date().toISOString()
      });

      writeJson(
        SUBSCRIBERS_FILE,
        subscribers.slice(-5000)
      );

      res.json({
        ok: true
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          "Unable to subscribe"
      });
    }
  }
);

/* =========================================================
   ADMIN AUTH
   ========================================================= */

function isAdmin(req) {
  if (!ADMIN_KEY) {
    return false;
  }

  const key =
    req.headers["x-admin-key"] ||
    req.headers["authorization"];

  return String(key || "")
    .replace(/^Bearer\s+/i, "") ===
    ADMIN_KEY;
}

/* =========================================================
   ADMIN ORDERS
   ========================================================= */

app.get(
  "/api/admin/orders",
  (req, res) => {

    if (!isAdmin(req)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const orders =
      readJson(
        ORDERS_FILE,
        []
      );

    res.json({
      ok: true,
      orders
    });
  }
);

/* =========================================================
   ADMIN NOTIFY BROADCAST
   ========================================================= */

app.post(
  "/api/admin/notify-broadcast",
  async (req, res) => {

    if (!isAdmin(req)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    try {
      const subject =
        cleanString(
          req.body.subject,
          300
        );

      const message =
        cleanString(
          req.body.message,
          5000
        );

      const subscribers =
        readJson(
          SUBSCRIBERS_FILE,
          []
        );

      let sent = 0;

      for (const subscriber of subscribers) {

        const ok =
          await sendEmail(
            subscriber.email,
            subject ||
              "MERCADO notification",

            `
              <div style="font-family:Arial,sans-serif">
                ${message}
              </div>
            `
          );

        if (ok) sent++;
      }

      res.json({
        ok: true,
        sent
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          "Broadcast failed"
      });
    }
  }
);

/* =========================================================
   ADMIN RUN REMINDERS
   ========================================================= */

async function runReminders() {

  if (!mailTransporter) {
    return {
      sent: 0,
      reason:
        "Email service not configured"
    };
  }

  const delayHours =
    Number(
      process.env.REMINDER_DELAY_HOURS ||
      24
    );

  const views =
    readJson(
      VIEWS_FILE,
      []
    );

  const now =
    Date.now();

  let sent = 0;

  for (const view of views) {

    if (view.reminded) {
      continue;
    }

    const viewedAt =
      new Date(
        view.viewedAt
      ).getTime();

    if (
      !Number.isFinite(viewedAt)
    ) {
      continue;
    }

    if (
      now - viewedAt <
      delayHours *
      60 *
      60 *
      1000
    ) {
      continue;
    }

    const product =
      view.product || {};

    const ok =
      await sendEmail(
        view.email,

        `Still interested in ${product.name || "this product"}?`,

        `
          <div style="font-family:Arial,sans-serif">
            <h2>MERCADO</h2>

            <p>
              You recently viewed:
              <strong>
                ${product.name || "this product"}
              </strong>
            </p>

            ${
              product.image
                ? `<img
                    src="${product.image}"
                    style="max-width:300px"
                  />`
                : ""
            }

            <p>
              Price:
              <strong>
                ${product.price || ""}
              </strong>
            </p>

            ${
              product.url
                ? `<p>
                    <a href="${product.url}">
                      View product
                    </a>
                  </p>`
                : ""
            }
          </div>
        `
      );

    if (ok) {
      view.reminded = true;
      sent++;
    }
  }

  writeJson(
    VIEWS_FILE,
    views.slice(-500)
  );

  return {
    sent
  };
}

app.post(
  "/api/admin/run-reminders",
  async (req, res) => {

    if (!isAdmin(req)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    try {
      const result =
        await runReminders();

      res.json({
        ok: true,
        ...result
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);

/*
  Run reminders every 30 minutes.
*/

setInterval(
  () => {
    runReminders()
      .catch(err =>
        console.error(
          "REMINDER JOB:",
          err.message
        )
      );
  },
  30 * 60 * 1000
);

/* =========================================================
   AI ENDPOINT
   ========================================================= */

app.post(
  "/api/ai",
  async (req, res) => {

    const apiKey =
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error:
          "AI service not configured"
      });
    }

    try {
      const question =
        cleanString(
          req.body.question,
          4000
        );

      const history =
        Array.isArray(req.body.history)
          ? req.body.history
          : [];

      const product =
        req.body.product || null;

      const messages = [
        {
          role: "system",
          content:
            "You are MERCADO's shopping assistant. Help customers understand products and shopping options clearly. Do not claim information that is not available."
        }
      ];

      for (
        const message of history.slice(-10)
      ) {
        if (
          message &&
          (message.role === "user" ||
            message.role === "assistant")
        ) {
          messages.push({
            role:
              message.role,

            content:
              String(
                message.content || ""
              ).slice(0, 4000)
          });
        }
      }

      messages.push({
        role: "user",

        content:
          JSON.stringify({
            question,
            product
          })
      });

      const response =
        await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                model:
                  process.env.OPENAI_MODEL ||
                  "gpt-4o-mini",

                messages,

                temperature:
                  0.3,

                max_tokens:
                  700
              })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        return res.status(502).json({
          ok: false,
          error:
            "AI provider error"
        });
      }

      const answer =
        data?.choices?.[0]?.message?.content ||
        "";

      res.json({
        ok: true,
        answer
      });

    } catch (err) {
      console.error(
        "AI ERROR:",
        err.message
      );

      res.status(500).json({
        ok: false,
        error:
          "AI request failed"
      });
    }
  }
);

/* =========================================================
   TRANSLATE
   ========================================================= */

app.post(
  "/api/translate",
  async (req, res) => {

    const apiKey =
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error:
          "Translation service not configured"
      });
    }

    try {
      const target =
        cleanString(
          req.body.target,
          50
        );

      const texts =
        Array.isArray(req.body.texts)
          ? req.body.texts
          : [];

      if (!target || !texts.length) {
        return res.status(400).json({
          ok: false,
          error:
            "target and texts are required"
        });
      }

      const prompt =
        `
Translate the following texts into ${target}.
Return ONLY a JSON array of translated strings,
in exactly the same order.

Texts:
${JSON.stringify(texts)}
`;

      const response =
        await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                model:
                  process.env.OPENAI_MODEL ||
                  "gpt-4o-mini",

                messages: [
                  {
                    role: "user",
                    content: prompt
                  }
                ],

                temperature:
                  0.1
              })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        return res.status(502).json({
          ok: false,
          error:
            "Translation provider error"
        });
      }

      const content =
        data?.choices?.[0]?.message?.content ||
        "[]";

      let translations;

      try {
        translations =
          JSON.parse(content);
      } catch {
        translations = [];
      }

      res.json({
        ok: true,
        translations
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          "Translation failed"
      });
    }
  }
);

/* =========================================================
   STATIC FRONTEND
   ========================================================= */

const publicDir =
  path.join(
    __dirname,
    "public"
  );

app.use(
  express.static(
    publicDir,
    {
      setHeaders:
        (res) => {
          res.setHeader(
            "Cache-Control",
            "no-cache, no-store, must-revalidate"
          );

          res.setHeader(
            "Pragma",
            "no-cache"
          );

          res.setHeader(
            "Expires",
            "0"
          );
        }
    }
  )
);

/*
  SPA fallback.
*/

app.get(
  "*",
  (req, res, next) => {

    if (
      req.path.startsWith("/api/")
    ) {
      return next();
    }

    res.sendFile(
      path.join(
        publicDir,
        "index.html"
      )
    );
  }
);

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
  (err, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      err
    );

    res.status(500).json({
      ok: false,
      error:
        "Internal server error"
    });
  }
);

/* =========================================================
   START
   ========================================================= */

app.listen(
  PORT,
  () => {

    console.log("");
    console.log(
      "===================================="
    );
    console.log(
      "        MERCADO SERVER"
    );
    console.log(
      "===================================="
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Public URL:",
      PUBLIC_BASE_URL
    );

    console.log(
      "Payment:",
      "GatePay.to"
    );

    console.log(
      "GatePay API:",
      GATEPAY_API
    );

    console.log(
      "Wallet configured:",
      GATEPAY_WALLET
        ? "YES"
        : "NO"
    );

    console.log(
      "eBay configured:",
      EBAY_CLIENT_ID &&
      EBAY_CLIENT_SECRET
        ? "YES"
        : "NO"
    );

    console.log(
      "MERCADO markup:",
      `$${PRICE_MARKUP}`
    );

    console.log(
      "===================================="
    );
    console.log("");
  }
);
