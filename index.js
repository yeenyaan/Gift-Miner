import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Проверка подписи Telegram initData
function verifyTelegramInitData(initDataRaw) {
  if (!initDataRaw) throw new Error('no_init_data');
  const urlParams = new URLSearchParams(initDataRaw);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  const data = [...urlParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const check = crypto.createHmac('sha256', secret).update(data).digest('hex');
  if (check !== hash) throw new Error('bad_hash');
  const userStr = urlParams.get('user');
  const user = userStr ? JSON.parse(userStr) : null;
  return { user };
}

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

app.post('/auth/telegram', async (req, res) => {
  try {
    const { initDataRaw, ref } = req.body;
    const tg = verifyTelegramInitData(initDataRaw);
    const tgId = BigInt(tg.user.id);
    const user = await prisma.user.upsert({
      where: { tgId },
      update: {},
      create: {
        tgId,
        username: tg.user.username ?? null,
        firstName: tg.user.first_name ?? null,
        lastName: tg.user.last_name ?? null,
        languageCode: tg.user.language_code ?? null,
      }
    });
    // Рефералка (упрощённо):
    if (ref && ref !== String(user.id)) {
      const exists = await prisma.referral.findFirst({ where: { inviteeId: user.id } });
      if (!exists) await prisma.referral.create({ data: { inviterId: ref, inviteeId: user.id } });
    }
    res.json({ ok: true, user });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e.message) });
  }
});

// Мок-провайдер подарков (заменим позже на реальный источник)
const mockGifts = [
  { code: 'plush_pepe', title: 'Plush Pepe', iconUrl: '', quantity: 3, baseIncomeCentsPer12h: 540 },
  { code: 'gold_coin', title: 'Gold Coin', iconUrl: '', quantity: 1, baseIncomeCentsPer12h: 1200 }
];

app.post('/gifts/sync', async (req, res) => {
  const { userId } = req.body;
  for (const g of mockGifts) {
    const gt = await prisma.giftType.upsert({
      where: { code: g.code },
      update: { title: g.title, iconUrl: g.iconUrl, baseIncomeCpm: g.baseIncomeCentsPer12h },
      create: { code: g.code, title: g.title, iconUrl: g.iconUrl, baseIncomeCpm: g.baseIncomeCentsPer12h, maxStreak: 14 }
    });
    await prisma.userGift.upsert({
      where: { userId_giftTypeId: { userId, giftTypeId: gt.id } },
      update: { quantity: g.quantity },
      create: { userId, giftTypeId: gt.id, quantity: g.quantity }
    });
  }
  res.json({ ok: true });
});

app.get('/gifts', async (req, res) => {
  const { userId } = req.query;
  const items = await prisma.userGift.findMany({ where: { userId: String(userId) }, include: { giftType: true } });
  const now = Date.now();
  const list = items.map(i => {
    const last = i.lastClaimAt ? i.lastClaimAt.getTime() : 0;
    const bins = Math.min(Math.floor((now - last) / HALF_DAY_MS), i.giftType.maxStreak);
    const income = bins * i.quantity * i.giftType.baseIncomeCpm;
    return { userGiftId: i.id, giftTypeId: i.giftTypeId, title: i.giftType.title, quantity: i.quantity, claimableCents: income };
  });
  res.json(list);
});

app.post('/gifts/claim', async (req, res) => {
  const { userId, giftTypeId } = req.body;
  const out = await prisma.$transaction(async tx => {
    const ug = await tx.userGift.findUniqueOrThrow({ where: { userId_giftTypeId: { userId, giftTypeId } }, include: { giftType: true } });
    const now = Date.now();
    const last = ug.lastClaimAt ? ug.lastClaimAt.getTime() : 0;
    const bins = Math.min(Math.floor((now - last) / HALF_DAY_MS), ug.giftType.maxStreak);
    if (bins <= 0) return { ok: false, gained: 0 };
    const gained = bins * ug.quantity * ug.giftType.baseIncomeCpm;
    await tx.user.update({ where: { id: userId }, data: { balanceCents: { increment: gained } } });
    await tx.userGift.update({ where: { id: ug.id }, data: { lastClaimAt: new Date(ug.lastClaimAt ? (last + bins * HALF_DAY_MS) : now) } });
    await tx.txn.create({ data: { userId, amountCents: gained, type: 'claim', meta: { giftTypeId, bins } } });
    return { ok: true, gained };
  });
  res.json(out);
});

app.get('/balance', async (req, res) => {
  const { userId } = req.query;
  const user = await prisma.user.findUnique({ where: { id: String(userId) } });
  if (!user) return res.status(404).json({ ok: false });
  res.json({ balanceCents: user.balanceCents, withdrawEnabled: false });
});

app.get('/', (req, res) => {
  res.send('Gift Miner backend is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));
