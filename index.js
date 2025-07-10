const express = require('express');
const axios = require('axios');

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

const SHOP = "testbestcustomer.myshopify.com";

async function fetchTodaySales() {
  try {
    const url = `${process.env.SHOPIFY_API_URL}/api/whatsapp-shopify?type=today_sales&shop=${SHOP}`;
    console.log('SHOPIFY_API_URL:', process.env.SHOPIFY_API_URL);
    console.log('Full request URL:', url);
    
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}`
      }
    });
    
    console.log('Response status:', response.status);
    return response.data.message;
  } catch (error) {
    if (error.response) {
      console.error("❌ Shopify API Error", {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else {
      console.error("❌ Unexpected Error", error.message);
    }
    return "Sorry, I couldn't retrieve today's sales data.";
  }
}

async function fetchTopCustomers() {
  try {
    const response = await axios.get(
      `${process.env.SHOPIFY_API_URL}/api/whatsapp-shopify?type=top_customers&shop=${SHOP}`, 
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}`
        }
      }
    );
    return response.data.message;
  } catch (error) {
    if (error.response) {
      console.error("❌ Shopify API Error (Top Customers)", {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else {
      console.error("❌ Unexpected Error (Top Customers)", error.message);
    }
    return "Sorry, I couldn't retrieve customer info.";
  }
}

async function askGroq(userText) {
  const summaryUrl = 'https://shopify-test-best-customers-app.onrender.com/daily-data.json';
  let contextText = '';

  try {
    const response = await fetch(summaryUrl);
    const json = await response.json();

    // Format context summary
    contextText = `Here is today's store summary:\n- Total orders: ${json.orderCount}\n- Total sales: $${json.salesTotal} ${json.currencyCode}\n- Top products: ${json.topProducts.map(p => `${p.title} (${p.count})`).join(', ')}`;
  } catch (error) {
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
