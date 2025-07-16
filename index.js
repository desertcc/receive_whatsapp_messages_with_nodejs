const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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
        // fallback to Groq
        const groqReply = await askGroq(text);
        await replyMessage(messages.from, groqReply, messages.id);
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
    // Get today's date in ISO format (YYYY-MM-DD)
    const today = new Date().toISOString().split('T')[0];
    
    // Query orders from Supabase where created_at is today
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, total_price, currency')
      .gte('created_at', `${today}T00:00:00`)
      .lt('created_at', `${today}T23:59:59`);
    
    if (error) throw error;
    
    if (!orders || orders.length === 0) {
      return "We haven't had any orders today yet.";
    }
    
    // Calculate total orders and sales
    const orderCount = orders.length;
    const totalSales = orders.reduce((sum, order) => sum + parseFloat(order.total_price), 0);
    const currency = orders[0].currency || 'USD';
    
    // Format the response
    return `We had ${orderCount} order${orderCount !== 1 ? 's' : ''} totaling $${totalSales.toFixed(2)} ${currency} today.`;
  } catch (error) {
    console.error("❌ Supabase Error (Today's Sales)", error);
    return "Sorry, I couldn't retrieve today's sales data at the moment.";
  }
}

async function fetchTopCustomers() {
  try {
    // Query customers from Supabase, ordered by total_spent DESC
    const { data: customers, error } = await supabase
      .from('customers')
      .select('first_name, last_name, total_spent, currency')
      .order('total_spent', { ascending: false })
      .limit(5);
    
    if (error) throw error;
    
    if (!customers || customers.length === 0) {
      return "We don't have any customer data available at the moment.";
    }
    
    // Format the response
    const currency = customers[0].currency || 'USD';
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

  try {
    // Get today's date in ISO format (YYYY-MM-DD)
    const today = new Date().toISOString().split('T')[0];
    
    // Query orders from Supabase for today
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, total_price, currency')
      .gte('created_at', `${today}T00:00:00`)
      .lt('created_at', `${today}T23:59:59`);
    
    if (ordersError) throw ordersError;
    
    // Query top products from Supabase
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('title, units_sold, price')
      .order('units_sold', { ascending: false })
      .limit(5);
    
    if (productsError) throw productsError;
    
    // Calculate totals
    const orderCount = orders ? orders.length : 0;
    const salesTotal = orders ? orders.reduce((sum, order) => sum + parseFloat(order.total_price), 0).toFixed(2) : 0;
    const currencyCode = orders && orders.length > 0 ? orders[0].currency : 'USD';
    
    // Format top products
    const topProductsText = products && products.length > 0 ?
      products.map(p => `${p.title} (${p.units_sold})`).join(', ') :
      'No product data available';
    
    // Format context summary
    contextText = `Here is today's store summary:\n- Total orders: ${orderCount}\n- Total sales: $${salesTotal} ${currencyCode}\n- Top products: ${topProductsText}`;
  } catch (error) {
    console.error("❌ Supabase Error (Store Summary)", error);
    contextText = "Store summary data is currently unavailable.";
  }

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content: `${contextText}\n\nAnswer questions about today's store performance based on this data.`,
        },
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

app.listen(3000, () => {
  console.log('✅ Server started on port 3000');
});
