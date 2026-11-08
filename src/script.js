/* 插电工坊 · 课堂脚本（台词 / 英文 / 教师提示 / 练习题）。台词只用本课词、复习词和已学基础词；超纲词在字幕里标橙。 */
(function (G) {
  'use strict';
  const L = (zh, en, teacher) => ({ zh, en, teacher });
  const S = {
    intro: [
      L('你好！我是王明。', 'Hi! I’m Wang Ming.', '老师自我介绍，用学员的名字打招呼。'),
      L('你是马丁，对吗？', 'You’re Martin, right?', '用本课句式“……，对吗？”问学员，引导回答“对”。'),
      L('今天我们认识插电式混合动力汽车。', 'Today we’ll get to know the plug-in hybrid electric vehicle.', '指着车说出课题。'),
    ],
    // ---- 第一站：X 光透视台（生词：认 → 辨 → 说）----
    a0: L('你看，这是插电式混合动力汽车。', 'Look, this is a plug-in hybrid electric vehicle.', '打开透视，让学员看到车里的部件。'),
    aRecog: [
      { part: 'engine', word: '发动机', line: L('这是发动机。跟我读：发动机。', 'This is the engine. Read after me: engine.', '【认】指着发动机说词，学员跟读。') },
      { part: 'motor', word: '驱动电机', line: L('这是驱动电机。跟我读：驱动电机。', 'This is the driving motor. Read after me.', '【认】指着驱动电机说词，学员跟读。') },
      { part: 'battery', word: '动力电池', line: L('这是动力电池。跟我读：动力电池。', 'This is the power battery. Read after me.', '【认】指着动力电池说词，学员跟读。') },
    ],
    aPlug: L('你看，这儿可以插电。插电式。跟我读：插电式。', 'Look, it can plug in here. Plug-in. Read after me: plug-in.', '【认】指着充电口说“插电式”，然后请学员亲手插上充电枪。'),
    aPlugDo: L('请你插电！', 'Please plug it in!', '动作指令：学员点充电枪（或说“插电”）。插上后，语料库接通。'),
    aHybrid: L('它有发动机，也有驱动电机。这叫混合动力。跟我读：混合动力。', 'It has an engine, and also a driving motor. That’s called hybrid power. Read after me.', '【认】两股能量同时流向车轮，说“混合动力”。'),
    aChoose: [
      { part: 'motor', ans: '驱动电机', others: ['发动机'], line: L('这是驱动电机还是发动机？', 'Is this the driving motor or the engine?', '【辨】二选一，学员只需分辨。') },
      { part: 'battery', ans: '动力电池', others: ['发动机'], line: L('这是动力电池还是发动机？', 'Is this the power battery or the engine?', '【辨】二选一。') },
      { part: 'engine', ans: '发动机', others: ['驱动电机'], line: L('这是发动机还是驱动电机？', 'Is this the engine or the driving motor?', '【辨】二选一。') },
    ],
    aSay: [
      { part: 'battery', ans: '动力电池', others: ['发动机', '驱动电机'], line: L('这是什么？', 'What is this?', '【说】不给提示，学员说对，部件才会动。') },
      { part: 'motor', ans: '驱动电机', others: ['发动机', '动力电池'], line: L('这是什么？', 'What is this?', '【说】') },
      { part: 'engine', ans: '发动机', others: ['驱动电机', '动力电池'], line: L('这是什么？', 'What is this?', '【说】') },
    ],
    aCar: L('这是什么汽车？', 'What kind of vehicle is this?', '【说】说出整车名称。'),
    aGood: L('很好！', 'Very good!', ''),
    shelfOn: L('你看，货架上多了这些词。', 'Look — the shelf has new words now.', '插电后：货架长出真实语料里的搭配，点任一个看出处。'),
    // ---- 第二站：并联接头（语法点1：也）----
    b1: L('纯电动汽车是新能源汽车。', 'Battery electric vehicles are new energy vehicles.', '【认】指着纯电动汽车。'),
    b2: L('插电式混合动力汽车也是新能源汽车。', 'Plug-in hybrids are also new energy vehicles.', '【认】指着插混车，重读“也”。'),
    bWhich: L('哪个对？', 'Which one is right?', '【辨】两句话选一句。插电前后，错误的那一句不一样。'),
    bBoard: L('现在你来：“也”放在哪儿？', 'Your turn: where does 也 go?', '【说】并联接头：把“也”插到对的位置，车轮才会转。'),
    bRead: L('很好！请你说一遍。', 'Great! Now say the whole sentence.', '学员把整句说一遍（可跳过）。'),
    // 练习1（课本 p35）：parts 中 null 为插槽；slots 与插槽一一对应；ok 为正确插槽序号
    yeItems: [
      { id: 'E1', parts: ['纯电动汽车', null, '是新能源汽车，', null, '插电式混合动力汽车', null, '是新能源汽车。'], ok: 2, cats: ['first', 'A', 'ok'], en: 'BEVs are new energy vehicles; plug-in hybrids are ___ new energy vehicles.' },
      { id: 'E2', parts: ['插电式混合动力汽车', null, '消耗燃油，', null, '消耗电能', null, '。'], ok: 1, cats: ['first', 'ok', 'END'], en: 'A plug-in hybrid consumes fuel, and ___ consumes electricity.' },
      { id: 'E3', parts: ['插电式混合动力汽车', null, '有驱动电机，', null, '有动力电池', null, '。'], ok: 1, cats: ['first', 'ok', 'END'], en: 'It has a driving motor, and ___ has a power battery.' },
      { id: 'E4', parts: ['要', null, '按时上班，', null, '要', null, '按时下班。'], ok: 1, cats: ['first', 'ok', 'other'], en: 'Go to work on time, and ___ leave work on time.' },
    ],
    // ---- 教小龙 ----
    dIntro: L('这是小龙，他是新来的学徒。现在你是师傅！', 'This is Xiaolong, the new apprentice. Now you’re the master!', '身份翻转：学员当师傅，教小龙。'),
    dWrongOff: L('纯电动汽车是新能源汽车，也插电式混合动力汽车是新能源汽车，对吗？', 'BEVs are new energy vehicles, also plug-in hybrids are new energy vehicles, right?', '固定课堂练习；使用已核实的“也”在主语前的错法（ln-ye-1场景改写），未插电时不显示语料扩展。'),
    dWrongOn: L('纯电动汽车是新能源汽车，也插电式混合动力汽车是新能源汽车，对吗？', 'BEVs are new energy vehicles, also plug-in hybrids are new energy vehicles, right?', '小龙故意说错。已插电：错句来自学习者真实偏误（“也”在主语前）。'),
    dFollow: L('嗯？车没动。', 'Hmm? The car didn’t move.', '学员教错了，小龙照做，车不动——让学员自己发现。'),
    dWhy: L('为什么叫混合动力汽车？', 'Why is it called a hybrid vehicle?', '小龙追问“为什么”：学员用课文回答。'),
    dSame: L('动力电池的“电”，电能的“电”，一样吗？', 'Is the 电 in 动力电池 the same as the 电 in 电能?', '小龙从字往外延伸，把专业词拆成基础字。'),
    dMore: L('你再说一个有“电”的词！', 'Say another word with 电 in it!', '学员说任意一个带“电”的词。'),
    dChainOn: L('我听说，后面的课还有动力电池系统，还有驱动电机外壳！', 'I heard later lessons have “power battery system” and “driving motor housing”!', '插电后：小龙知道这本书后面会学到的搭配（教材库频次）。'),
    dChainOff: L('电……还有吗？', 'Electric… anything else?', '未插电：小龙没有数据可说。'),
    dThanks: L('谢谢师傅！我懂了。', 'Thank you, master! I get it now.', ''),
    // ---- 第三站：质检确认台（语法点2：……，对吗？）----
    c0: L('现在我们去看这三辆车。', 'Now let’s look at these three cars.', '移动到三车展台。'),
    cWarm: [
      { truth: true, fixes: [], line: L('你是工作人员，对吗？', 'You are a staff member, right?', '【认】课本 p36 例句1：回答“对”。') },
      { truth: false, fixes: ['燃油车不是新能源汽车', '不是新能源汽车'], line: L('燃油车也是新能源汽车，对吗？', 'Fuel cars are new energy vehicles too, right?', '【认】课本 p36 例句2：回答“不是，……”。') },
    ],
    cJudge: [
      { car: 'phev', truth: false, fixes: ['是新能源汽车'], line: L('插电式混合动力汽车不是新能源汽车，对吗？', 'Plug-in hybrids are not new energy vehicles, right?', '【辨】判断正误（课本 p34）：说“不是”，还要说出对的。') },
      { car: 'phev', truth: false, fixes: ['有发动机'], line: L('插电式混合动力汽车没有发动机，对吗？', 'Plug-in hybrids have no engine, right?', '【辨】') },
      { car: 'phev', truth: true, fixes: [], line: L('插电式混合动力汽车消耗燃油，也消耗电能，对吗？', 'A plug-in hybrid consumes fuel and also electricity, right?', '【辨】') },
      { car: 'phev', truth: true, fixes: [], line: L('插电式混合动力汽车有动力电池，对吗？', 'A plug-in hybrid has a power battery, right?', '【辨】'), lineOn: L('插电式混合动力汽车有动力电池，对吧？', 'A plug-in hybrid has a power battery, right?', '插电后王明换成口语更常用的“对吧”，学员要听得懂。') },
    ],
    cPick: L('对吗，还是呢？', '对吗 or 呢?', '【辨】课本 p36 练习2：心里有看法用“对吗”，问另一个用“呢”。'),
    neItems: [
      { stem: '燃油车也是新能源汽车，＿＿？', ans: '对吗', car: 'ice' },
      { stem: '这是一辆新能源汽车，那一辆＿＿？', ans: '呢', car: 'bev' },
      { stem: '插电式混合动力汽车是新能源汽车，＿＿？', ans: '对吗', car: 'phev' },
      { stem: '纯电动车是新能源汽车，燃油车＿＿？', ans: '呢', car: 'ice' },
    ],
    cAsk: L('现在你问我。用“……，对吗？”', 'Now you ask me — use “……，对吗？”.', '【说】学员自己用“……，对吗？”向王明求证，王明按事实回答。'),
    cAskMore: L('很好！再问一个。', 'Good! Ask one more.', ''),
    cDone: L('很好！这辆车可以走了。', 'Very good! This car can go now.', '出厂：车开出车间。'),
  };
  // Authored explanation for the apprentice's question particle, not an HSK grade.
  S.dialogueGloss = { '呀': 'sentence-final particle: a curious tone' };
  G.CDG_SCRIPT = S;
  if (typeof module !== 'undefined') module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
