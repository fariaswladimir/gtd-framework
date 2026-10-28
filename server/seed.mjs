// Dados de exemplo para uma instalação nova (fictícios). Os dados reais ficam em data/gtd.db, fora do git.
// Para começar vazio: GTD_SEED=0.
export function buildSeed(todayStr) {
  const projects = [
    { name: 'Trabalho principal', lane: 'sustento', mode: 'kanban', status: 'ativo', progress: null, priority: 1, hub: 'edge',
      next_step: 'Facilitar a daily e acompanhar as frentes do programa',
      kanban: { todo: ['Sprint Review', 'Retrospectiva do time', 'Acompanhar as frentes do programa'], doing: ['Facilitação da daily'], done: ['Planning da sprint'] } },
    { name: 'Processos seletivos', lane: 'sustento', mode: 'todo', status: 'ativo', progress: null, priority: 2, hub: 'pessoal',
      next_step: 'Acompanhar os processos em andamento',
      todos: ['Processo seletivo A — em andamento', 'Processo seletivo B — enviar documentos'] },
    { name: 'RSL XAI em MAS', lane: 'paralelos', mode: 'projeto', status: 'ativo', progress: 65, priority: 1, hub: 'doutorado',
      next_step: 'Escrever a seção de resultados do artigo', github: 'usuario/rsl-xai-mas',
      steps: ['Protocolo PRISMA ✓', 'Corpus das bases ✓', 'Análise e clusters ✓', 'Redação do artigo', 'Submissão'], current_step: 3 },
    { name: 'Survey de adoção de IA', lane: 'paralelos', mode: 'projeto', status: 'ativo', progress: 25, priority: 2, hub: 'doutorado',
      next_step: 'Iniciar a coleta piloto',
      steps: ['Instrumento com LGPD ✓', 'Coleta piloto', 'Entrevistas semiestruturadas', 'Análise qualitativa', 'Artigo'], current_step: 1 },
    { name: 'Estágio docência', lane: 'paralelos', mode: 'todo', status: 'ativo', progress: null, priority: 2, hub: 'doutorado',
      next_step: 'Preparar as aulas do módulo',
      todos: ['Preparar as aulas do módulo', 'Ministrar as aulas', 'Entregar o relatório do estágio'] },
    { name: 'Marca pessoal', lane: 'sandbox', mode: 'projeto', status: 'ativo', progress: 40, priority: 2, hub: 'pessoal',
      next_step: 'Gravar os primeiros vídeos curtos',
      steps: ['Questionário de identidade ✓', 'Tom e pilares ✓', 'Vídeos curtos e carrosséis', 'Site pessoal', 'Primeiras publicações'], current_step: 2 },
    { name: 'HQ autoral', lane: 'sandbox', mode: 'projeto', status: 'ativo', progress: 55, priority: 1, hub: 'side-projects',
      next_step: 'Gerar a arte da cena atual',
      steps: ['Bíblia da história ✓', 'Referências visuais ✓', 'Roteiro cena a cena ✓', 'Arte final', 'Autopublicação'], current_step: 3 },
    { name: 'Consultoria em dados', lane: 'paralelos', mode: 'projeto', status: 'backlog', progress: 15, hub: 'consultoria-dados',
      steps: ['Catálogo de serviços ✓', 'Site da consultoria', 'Funis de venda', 'Primeiros clientes', 'Capacitação corporativa'], current_step: 1 },
    { name: 'Consultoria em automação', lane: 'paralelos', mode: 'projeto', status: 'backlog', progress: 5, hub: 'consultoria-n8n',
      steps: ['Curso de automação', 'Projetos piloto', 'Catálogo de automações', 'Site próprio'], current_step: 0 },
    { name: 'Curta-metragem com IA', lane: 'sandbox', mode: 'projeto', status: 'backlog', progress: 20, hub: 'side-projects',
      steps: ['Argumento e roteiro ✓', 'Testes visuais', 'Geração de cenas', 'Edição e som', 'Publicação'], current_step: 1 },
    { name: 'Jogo em pixel art', lane: 'sandbox', mode: 'projeto', status: 'backlog', progress: 10, hub: 'side-projects',
      steps: ['Conceito ✓', 'Sprites', 'Mecânica', 'Mapa', 'Versão jogável'], current_step: 1 },
    { name: 'Ontologia de domínio', lane: 'paralelos', mode: 'projeto', status: 'backlog', progress: 30, hub: 'doutorado',
      steps: ['Modelo inicial (OWL) ✓', 'Refatoração em módulos', 'Cobertura de novos casos', 'Publicação acadêmica'], current_step: 1 },
    { name: 'Sistema das Artes', lane: 'sandbox', mode: 'projeto', status: 'backlog', progress: 60, hub: 'side-projects',
      steps: ['Artes liberais ✓', 'Pintura, música, desenho e cinema ✓', 'Arquitetura, escultura, literatura e dança', 'Compilação final'], current_step: 2 },
    { name: 'Diretório de links', lane: 'sandbox', mode: 'kanban', status: 'backlog', progress: null, hub: 'side-projects',
      kanban: { todo: ['Vitrine de destaques'], doing: ['Popular o diretório'], done: ['Painel de administração'] } },
    { name: 'Creative Analytics', lane: 'sandbox', mode: 'projeto', status: 'backlog', progress: 5, hub: 'side-projects',
      steps: ['Definir escopo', 'Configurar o projeto', 'MVP', 'Testes'], current_step: 0 },
    { name: 'Jogo de masmorra', lane: 'sandbox', mode: 'projeto', status: 'backlog', progress: 10, hub: 'side-projects',
      steps: ['Conceito ✓', 'Game design', 'Protótipo', 'Playtest'], current_step: 1 },
    { name: 'Raio-X', lane: 'sandbox', mode: 'projeto', status: 'backlog', progress: 10, hub: 'side-projects',
      steps: ['Definir escopo', 'Desenvolvimento', 'Testes', 'Deploy'], current_step: 0 },
  ];

  const inbox = [
    { text: 'Convite para revisar artigo em coautoria', source: 'Gmail', hub: 'doutorado' },
    { text: 'Verificar alerta de segurança da conta institucional', source: 'Gmail', hub: 'pessoal' },
    { text: 'Agendar a próxima orientação', source: 'Google Keep', hub: 'doutorado' },
    { text: 'Revisar os critérios de exclusão do protocolo', source: 'Google Drive', hub: 'doutorado' },
    { text: 'creative-analytics: commits recentes — revisar escopo', source: 'GitHub', hub: 'side-projects' },
    { text: 'jogo-de-masmorra: push recente — alinhar game design', source: 'GitHub', hub: 'side-projects' },
    { text: 'Preparar as aulas do estágio docência', source: 'Claude', hub: 'doutorado' },
    { text: 'Site pessoal — definir a estratégia de vendas', source: 'Google Keep', hub: 'pessoal' },
    { text: 'Funis de venda — mapear os materiais de cada produto', source: 'Google Keep', hub: 'consultoria-dados' },
    { text: 'Comprar teclado novo para o home office', source: 'WhatsApp self', hub: 'pessoal' },
    { text: 'Repositório público — conferir se o README está atualizado', source: 'GitHub', hub: 'doutorado' },
    { text: 'Feedback da sprint — pontos de melhoria do time', source: 'Claude Edge', hub: 'edge' },
    { text: 'Lovable: protótipo do site da consultoria — testar o MVP', source: 'Lovable', hub: 'consultoria-dados' },
    { text: 'Lovable: experimento de chatbot de portfólio — decidir se vira projeto', source: 'Lovable', hub: 'side-projects' },
    { text: 'Diretório de links: vitrine de destaques', source: 'Claude', hub: 'side-projects' },
    { text: 'Processo seletivo A — acompanhar a próxima etapa', source: 'Gmail', hub: 'pessoal' },
  ].reverse(); // a inbox lista do mais novo para o mais antigo

  const tasks = [
    { period: 'manhã', text: 'Artigo da RSL — avançar a seção de resultados', lane: 'paralelos', carry: 1, project: 'RSL XAI em MAS' },
    { period: 'manhã', text: 'Revisar a planilha de análise — clusters', lane: 'paralelos', carry: 2, project: 'RSL XAI em MAS' },
    { period: 'tarde', text: 'Facilitar a daily do time', lane: 'sustento', project: 'Trabalho principal' },
    { period: 'tarde', text: 'Processar a inbox (GitHub, Gmail, Keep, Lovable)', lane: 'sandbox' },
    { period: 'tarde', text: 'Acompanhar os processos seletivos', lane: 'sustento', project: 'Processos seletivos' },
    { period: 'noite', text: 'HQ — gerar a arte da cena atual', lane: 'sandbox', project: 'HQ autoral' },
    { period: 'noite', text: 'Revisão diária de 5 min — fechar o dia e preparar amanhã', lane: 'sandbox' },
  ].map(t => ({ ...t, date: todayStr }));

  const DEFAULT_SUBS = {
    'Saúde': ['Exercício físico', 'Alimentação', 'Sono', 'Saúde mental'],
    'Carreira': ['Cargo atual', 'Formação', 'Certificações', 'Plano de carreira'],
    'Finanças': ['Renda principal', 'Renda extra', 'Planejamento', 'Reserva'],
    'Relacionamentos': ['Família nuclear', 'Família extendida', 'Amizades', 'Comunidade'],
    'Desenvolvimento': ['Estudo formal', 'Aprendizado contínuo', 'Mentoria', 'Projetos pessoais'],
    'Lazer': ['Hobbies criativos', 'Entretenimento', 'Esporte/jogo', 'Cultura'],
    'Espiritualidade': ['Propósito', 'Prática contemplativa', 'Valores', 'Contribuição'],
    'Ambiente': ['Moradia', 'Espaço de trabalho', 'Ferramentas', 'Entorno'],
  };

  const cadences = [
    { freq: 'Diária', title: 'Abertura + Fechamento', duration: '5 + 5 min · início e fim do dia',
      items: ['Revisar a agenda do dia', 'Selecionar no máximo 7 tarefas (manhã, tarde e noite)', 'Checar e-mail, notas e mensagens para mim mesmo', 'Ao final: marcar concluídas e anotar carry-overs', 'Capturar pendências soltas na inbox'] },
    { freq: 'Semanal', title: 'Revisão Semanal', duration: '30 min · domingo',
      items: ['Esvaziar as inboxes (e-mail, notas, mensagens, notificações do GitHub)', 'Revisar o WIP das 3 lanes e os repositórios ativos', 'Verificar projetos pausados (alerta de 60 dias)', 'Planejar a semana e distribuir as entregas', 'Checar carry-overs recorrentes (regra dos 3 dias)', 'Levar notas soltas para a inbox'] },
    { freq: 'Mensal', title: 'Refino Estratégico', duration: '1 hora · 1º domingo do mês',
      items: ['Revisar o ciclo de vida de todos os projetos', 'Mover projetos entre estados (backlog/ativo/pausado)', 'Avaliar o WIP global (7 ativos) contra a capacidade real', 'Revisar o GitHub: commits e PRs pendentes', 'Post-mortem curto dos projetos abandonados'] },
    { freq: 'Trimestral', title: 'Roda da Vida Completa', duration: '2 horas · a cada trimestre',
      items: ['Refazer o diagnóstico da Roda da Vida (8 áreas)', 'Preencher a matriz de tensões (28 interseções)', 'Ajustar a distribuição de WIP entre as lanes', 'Definir os OKRs do trimestre', 'Post-mortem completo dos projetos concluídos', 'Revisar as metas de longo prazo'] },
  ];

  const links = [
    { name: 'Trabalho', icon: '🏢', links: [{ label: 'Teams', url: 'https://teams.microsoft.com' }, { label: 'Outlook', url: 'https://outlook.office.com' }] },
    { name: 'Pesquisa', icon: '🎓', links: [{ label: 'Google Scholar', url: 'https://scholar.google.com' }, { label: 'Semantic Scholar', url: 'https://www.semanticscholar.org' }] },
    { name: 'Produtividade', icon: '⚡', links: [{ label: 'Gmail', url: 'https://mail.google.com' }, { label: 'Google Keep', url: 'https://keep.google.com' }, { label: 'Google Drive', url: 'https://drive.google.com' }, { label: 'Google Calendar', url: 'https://calendar.google.com' }] },
    { name: 'Desenvolvimento', icon: '💻', links: [{ label: 'GitHub', url: 'https://github.com' }, { label: 'Lovable', url: 'https://lovable.dev' }] },
    { name: 'IAs', icon: '🤖', links: [{ label: 'Claude', url: 'https://claude.ai' }] },
    { name: 'Referências', icon: '📚', links: [] },
  ];

  const meds_list = [
    { id: 'med-manha', label: 'Medicamento da manhã', dose: '', time: 'manhã' },
    { id: 'med-noite', label: 'Medicamento da noite', dose: '', time: 'noite' },
  ];

  return {
    projects, inbox, tasks,
    state: {
      areas: Object.entries(DEFAULT_SUBS).map(([name, subs]) => ({ name, score: 5, subs: subs.map(label => ({ label, score: 5 })) })),
      default_subs: DEFAULT_SUBS,
      cadences, links, meds_list,
      health: {}, meds: {}, reviews: {}, webhooks: [], tensions: null,
    },
  };
}
