console.log("🟢 WhatsApp server is starting...");

const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Initialize Supabase client
let supabase;
try {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseKey) {
    console.log("🔌 Initializing Supabase client...");
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase client initialized");
  } else {
    console.warn("⚠️ Supabase URL or key missing, some features will be disabled");
  }
} catch (error) {
  console.error("❌ Failed to initialize Supabase client:", error);
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Whatsapp with Node.js and Webhooks');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];

  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  console.log("📩 Incoming Webhook Payload:", JSON.stringify(req.body, null, 2));
  
  const { entry } = req.body;
  if (!entry || entry.length === 0) return res.status(400).send('Invalid Request');

  const changes = entry[0].changes;
  if (!changes || changes.length === 0) return res.status(400).send('Invalid Request');

  const statuses = changes[0].value.statuses ? changes[0].value.statuses[0] : null;
  const messages = changes[0].value.messages ? changes[0].value.messages[0] : null;

  if (statuses) {
    console.log(`
      MESSAGE STATUS UPDATE:
      ID: ${statuses.id},
      STATUS: ${statuses.status}
    `);
  }

  if (messages) {
    if (messages.type === 'text') {
      const text = messages.text.body.toLowerCase();

      if (text.includes("how much") && text.includes("sell")) {
        const reply = await fetchTodaySales();
        await replyMessage(messages.from, reply, messages.id);
      } else if (text.includes("top customers")) {
        const reply = await fetchTopCustomers();
        await replyMessage(messages.from, reply, messages.id);
      } else {
        // fallback to Groq with refinement
        const rawAnswer = await askGroq(text);
        const refinedReply = await refineGroq(rawAnswer, text);
        await replyMessage(messages.from, refinedReply, messages.id);
      }
    }

    if (messages.type === 'interactive') {
      if (messages.interactive.type === 'list_reply') {
        sendMessage(messages.from, `You selected: ${messages.interactive.list_reply.title}`);
      }

      if (messages.interactive.type === 'button_reply') {
        sendMessage(messages.from, `You selected: ${messages.interactive.button_reply.title}`);
      }
    }

    console.log(JSON.stringify(messages, null, 2));
  }

  res.status(200).send('Webhook processed');
});

async function fetchTodaySales() {
  try {
    // Check if Supabase client is initialized
    if (!supabase) {
      console.warn("⚠️ Supabase client not initialized in fetchTodaySales()");
      return "Sorry, I couldn't retrieve today's sales data at the moment.";
    }
    
    // Get today's date in ISO format (YYYY-MM-DD)
    const today = new Date().toISOString().split('T')[0];
    console.log(`📅 Querying orders for date: ${today}`);
    
    // Query orders from Supabase where created_at is today
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, total_price')
      .gte('created_at', `${today}T00:00:00`)
      .lt('created_at', `${today}T23:59:59`);
    
    if (error) throw error;
    
    if (!orders || orders.length === 0) {
      return "We haven't had any orders today yet.";
    }
    
    // Calculate total orders and sales
    const orderCount = orders.length;
    const totalSales = orders.reduce((sum, order) => sum + parseFloat(order.total_price), 0);
    
    // Format the response - use USD as default currency since it's not in the database
    return `We had ${orderCount} order${orderCount !== 1 ? 's' : ''} totaling $${totalSales.toFixed(2)} USD today.`;
  } catch (error) {
    console.error("❌ Supabase Error (Today's Sales)", error);
    return "Sorry, I couldn't retrieve today's sales data at the moment.";
  }
}

async function fetchTopCustomers() {
  try {
    // Check if Supabase client is initialized
    if (!supabase) {
      console.warn("⚠️ Supabase client not initialized in fetchTopCustomers()");
      return "Sorry, I couldn't retrieve customer info at the moment.";
    }
    
    console.log("👤 Querying top customers");
    
    // Query customers from Supabase, ordered by total_spent DESC
    const { data: customers, error } = await supabase
      .from('customers')
      .select('first_name, last_name, total_spent')
      .order('total_spent', { ascending: false })
      .limit(5);
    
    if (error) throw error;
    
    if (!customers || customers.length === 0) {
      return "We don't have any customer data available at the moment.";
    }
    
    // Format the response (using USD as default currency)
    const topCustomersText = customers
      .map(customer => `${customer.first_name} ${customer.last_name} ($${parseFloat(customer.total_spent).toFixed(0)})`)
      .join(', ');
    
    return `Our top customers are ${topCustomersText}.`;
  } catch (error) {
    console.error("❌ Supabase Error (Top Customers)", error);
    return "Sorry, I couldn't retrieve customer info at the moment.";
  }
}

async function askGroq(userText) {
  let contextText = '';

  // Static database schema description for Groq
  const schemaDescription = `
# Database Schema
orders: id (int), total_price (float), created_at (timestamp), customer_id (int), product_id (int)
products: id (int), title (string), price (float)
customers: id (int), first_name (string), last_name (string), total_spent (float)
`;

  try {
    // Check if Supabase client is initialized
    if (!supabase) {
      console.warn("⚠️ Supabase client not initialized in askGroq()");
      contextText = "Store summary data is currently unavailable.";
    } else {
      console.log("🤖 Preparing context for Groq query");
      
      // Get today's date in ISO format (YYYY-MM-DD)
      const today = new Date().toISOString().split('T')[0];
      
      // Get all available tables and their raw data to provide to Groq
      // This approach is more resilient to schema changes
      
      // Query orders from Supabase for today with all columns
      const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('*')
        .gte('created_at', `${today}T00:00:00`)
        .lt('created_at', `${today}T23:59:59`);
      
      if (ordersError) throw ordersError;
      
      // Query products - get all columns
      const { data: products, error: productsError } = await supabase
        .from('products')
        .select('*')
        .limit(10);
      
      if (productsError) throw productsError;
      
      // Query customers - get all columns
      const { data: customers, error: customersError } = await supabase
        .from('customers')
        .select('*')
        .limit(10);
      
      if (customersError) throw customersError;
      
      // Calculate basic stats regardless of schema
      const orderCount = orders ? orders.length : 0;
      const salesTotal = orders ? orders.reduce((sum, order) => {
        const price = order.total_price || order.price || 0;
        return sum + parseFloat(price);
      }, 0).toFixed(2) : 0;
      const currencyCode = 'USD'; // Default currency
      
      // Format context summary with raw data for Groq to analyze
      contextText = `
# Today's Store Summary (${today})
- Total orders: ${orderCount}
- Total sales: $${salesTotal} ${currencyCode}

# Raw Data from Database
## Orders (last 24 hours)
${JSON.stringify(orders, null, 2)}

## Products (top 10)
${JSON.stringify(products, null, 2)}

## Customers (top 10)
${JSON.stringify(customers, null, 2)}
      `;
      
      // Log that we're providing raw data to Groq
      console.log('📊 Providing raw Supabase data to Groq for analysis');
    }
  } catch (error) {
    console.error("❌ Supabase Error (Store Summary)", error);
    contextText = "Store summary data is currently unavailable.";
  }

    // Build dynamic prompt combining schema and data for Groq analysis
  const prompt = `
You are an AI assistant that uses the given Supabase database schema to interpret and analyze data.

Schema:
${schemaDescription}

Data:
${contextText}

Answer the user's question based on the schema and data. If additional data is needed, provide the appropriate Supabase query.
`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'moonshotai/kimi-k2-instruct',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userText }
      ]
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.choices[0].message.content.trim();
}

async function refineGroq(rawAnswer, question) {
  // Rewrite raw Groq output into a concise, natural response
  const prompt = `You are a helpful assistant that rewrites raw answers into a natural, concise response.

Original question: ${question}

Raw answer:
${rawAnswer}
`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'moonshotai/kimi-k2-instruct',
      messages: [
        { role: 'system', content: prompt }
      ]
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content.trim();
}

async function sendMessage(to, body) {
  await axios({
    url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }
  });
}

async function replyMessage(to, body, messageId) {
  await axios({
    url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
      context: { message_id: messageId }
    }
  });
}

// Optional: Keep your sendList and sendReplyButtons functions if needed

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ WhatsApp server running on port ${PORT}`);
});
