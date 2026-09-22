const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  try {
    const ws = await prisma.workspace.findUnique({ where: { personalOwnerId: 'cmubfk17l0000dly3tubpgceh' } });
    console.log('workspace', ws && ws.id);
    const p = await prisma.project.create({ data: { workspaceId: ws.id, name: 'Work', instructions: 'Be concise.', role: 'owner' } });
    console.log('created project', p.id);
  } catch (e) {
    console.error('ERROR:', e.message);
    if (e.meta) console.error('meta:', JSON.stringify(e.meta));
  } finally { await prisma.$disconnect(); }
})();
