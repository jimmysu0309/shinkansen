// content-detect.js — Shinkansen 段落偵測
// 負責語言偵測、容器排除、段落收集（collectParagraphs）、fragment 抽取。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  // ─── v0.76: 自動語言偵測 ─────────────────────────────────
  // 補字策略:detectTextLang 用 simpCount/cjkCount ≥ 0.2 判 zh-Hans。短文(< 30 cjk)
  // 在 set 命中率低時 ratio 過不了門檻會被誤判 zh-Hant。真實案例:X 引用文章卡片
  // "手冲咖啡进阶指北：冠军参数如何变成你的日常 - 少数派" 23 cjk 內含 8 簡中字,但
  // 原 set 只有「进数变数」4 字命中,4/23 ≈ 0.17 < 0.2 → 整段被當「已是繁中」跳過,
  // 卡片標題永遠不翻。補上常見高頻簡中專屬字,讓覆蓋率夠跨過閾值。
  //
  // v1.9.15:雙向偵測。原本只查 SIMPLIFIED_ONLY_CHARS 並用 0.2 門檻判 zh-Hans,
  // 其餘 fallback 為 zh-Hant — 對於簡體比例低於 0.2 的長 SC 文章(常見:技術新聞、
  // 含大量人名/機構名/同形字/英數混排的中國科技報導)會誤判為 zh-Hant 整篇跳過。
  // 真實案例:eet-china.com 的「摩尔线程一季报扭亏」文章,9 段簡體比例落在
  // 0.109-0.183 之間,全部被誤判 zh-Hant 跳過不翻。
  //
  // 雙向修法:新增 TRADITIONAL_ONLY_CHARS(跟 SIMPLIFIED_ONLY_CHARS 一一對映繁體寫法),
  // detectTextLang 同時計算兩邊命中數。任一邊乾淨即 short-circuit:
  //   - simpCount > 0 且 tradCount == 0 → zh-Hans(肯定 SC)
  //   - tradCount > 0 且 simpCount == 0 → zh-Hant(肯定 TC)
  // 兩邊都命中或都沒命中 → 走既有比例邏輯(維持 v0.76 短文補字策略不破壞)。
  // 簡繁特徵字集:v1.9.15 起為人工 curated 清單,簡繁互轉功能 vendor OpenCC 字典後
  // 改由 tools/generate-zh-char-sets.mjs 完備生成(curated 清單覆蓋有限,短標題只含
  // 清單外簡體字時 simpCount=0 → ratio fallback 誤判 zh-Hant 被跳過)。
  // 生成判準(防簡繁共用字誤判)與再生方式見腳本檔頭;歧義字(干/后/里/台/据/几…
  // 繁體文本也用的字)一律排除,確保「繁體短文絕不誤判 zh-Hans」優先於簡體覆蓋率。
  // ── GENERATED:ZH-CHAR-SETS BEGIN(tools/generate-zh-char-sets.mjs,勿手改)──
  // 簡體特徵字 2657+9 字 / 繁體特徵字 3134+19 字
  //(+N 為準特徵 tier:繁/簡對側語料出現 ≤ 3 次的極邊緣共用字,例 么),
  // 判準見生成腳本檔頭
  const SIMPLIFIED_ONLY_CHARS = new Set("㐷㐹㐽㑇㑈㑔㑩㓆㓥㓰㔉㖊㖞㘎㚯㛀㛟㛠㛣㛤㛿㟆㟜㟥㡎㤘㤽㥪㧏㧐㧑㧟㧰㨫㭎㭏㭣㭤㭴㱩㱮㲿㳔㳕㳠㳡㳢㳽㴋㶉㶶㶽㺍㻅㻏㻘䀥䁖䂵䃅䅉䅟䅪䇲䉤䌶䌷䌸䌹䌺䌻䌼䌽䌾䌿䍀䍁䍠䎬䏝䑽䓓䓕䓖䓨䗖䘛䘞䙊䙌䙓䜣䜤䜥䜧䜩䝙䞌䞍䞎䞐䟢䢀䢁䢂䥺䥽䥾䥿䦀䦁䦂䦃䦅䦆䦶䦷䩄䭪䯃䯄䯅䲝䲞䲟䲠䲡䲢䲣䴓䴔䴕䴖䴗䴘䴙䶮万与专业丛东丝丢两严丧个临为丽举么义乌乐乔习乡书买乱争亏亘亚产亩亲亵亸亿仅从仑仓仪们众优会伛伞伟传伡伣伤伥伦伧伪伫体佥侠侣侥侦侧侨侩侪侬侭俣俦俨俩俪俫俭债倾偬偻偾偿傤傥傧储傩儿兑兖兰关兴兹养兽冁内冈册写军农冯冲决况冻净凄凉减凑凛凤凫凭凯击凿刍刘则刚创删别刬刭刹刽刾刿剀剂剐剑剥剧劝办务劢动励劲劳势勋勚匀匦匮区医华协单卖卢卤卧卫却卺厂厅历厉压厌厍厐厕厢厣厦厨厩厮县叁参叆叇双发变叙叠号叹叽吓吕吗吨听启吴呐呒呓呕呖呗员呙呛呜咏咙咛咝咤响哑哒哓哔哕哗哙哜哝哟唛唝唠唡唢唤啧啬啭啮啯啰啴啸喷喽喾嗫嗳嘘嘤嘱噜嚣团园囱围囵国图圆圣圹场坏块坚坛坜坝坞坟坠垄垅垆垒垦垩垫垭垯垱垲垴埘埙埚堑堕塆墙壮声壳壶壸处备复够头夹夺奁奂奋奖奥妆妇妈妩妪妫姗姹娄娅娆娇娈娱娲娴婳婴婵婶媪媭嫒嫔嫱嬷孙学孪宁宝实宠审宪宫宽宾寝对寻导寿将尔尘尝尧尴尽层屃屉届属屡屦屿岁岂岖岗岘岚岛岭岽岿峃峄峡峣峤峥峦崂崃崄崭嵘嵚嵝巅巩巯币帅师帏帐帜带帧帮帱帻帼幂并广庄庆庐庑库应庙庞废庼廪开异弃弑张弥弪弯弹强归当录彟彦彨彻径徕忆忏忧忾怀态怂怃怄怅怆怜总怼怿恋恳恶恸恹恺恻恼恽悦悫悬悭悮悯惊惧惨惩惫惬惭惮惯愠愤愦慑慭懑懒懔戆戋戏戗战戬戯户扑执扩扪扫扬扰抚抛抟抠抡抢护报担拟拢拣拥拦拧拨择挂挚挛挜挝挞挟挠挡挢挣挤挥挦捝捞损捡换捣掳掴掷掸掺掼揽揾揿搀搁搂搄搅携摄摅摆摇摈摊撄撑撵撷撸撺擜擞攒敌敚敛敩数斋斓斩断无旧时旷旸昙昵昼昽显晋晒晓晔晕晖暂暅暧术机杀杂权条来杨杩极构枞枢枣枥枧枨枪枫枭柠柽栀栅标栈栉栊栋栌栎栏树栖样栾桠桡桢档桤桥桦桧桨桩桪梦梼梾梿检棁棂椁椝椟椠椢椤椫椭椮楼榄榅榇榈榉榝槚槛槟槠横樯樱橥橱橹橼檩欢欤欧歼殁殇残殒殓殚殡殴毁毂毕毙毡毵毶氇气氢氩氲汇汉汤汹沄沟没沣沤沥沦沧沨沩沪泞泪泶泷泸泺泻泼泽泾洁洒洼浃浅浆浇浈浉浊测浍济浏浐浑浒浓浔浕涚涛涝涞涟涠涡涢涣涤润涧涨涩渊渌渍渎渐渑渔渖渗温湾湿溁溃溅溆溇滗滚滞滟滠满滢滤滥滦滨滩滪潆潇潋潍潜潴澛澜濑濒灏灭灯灵灾灿炀炉炖炜炝点炼炽烁烂烃烛烟烦烧烨烩烫烬热焕焖焘煴爱爷牍牦牵牺犊状犷犸犹狈狝狞独狭狮狯狰狱狲猃猎猕猡猪猫猬献獭玑玙玚玛玮环现玱玺珐珑珰珲琎琏琐琼瑶瑷瑸璎瓒瓮瓯电画畅畴疖疗疟疠疡疬疭疮疯疱疴痈痉痒痖痨痪痫瘅瘆瘗瘘瘪瘫瘾瘿癞癣癫皑皱皲盏盐监盖盗盘眍眦眬睁睐睑瞆瞒瞩矫矶矾矿砀码砖砗砚砜砺砻砾础硁硕硖硗硙硚硵碍碛碜碱礼祃祎祢祯祷祸禀禄禅离秃秆种积称秽秾稆税稣稳穑穞穷窃窍窎窑窜窝窥窦窭竖竞笃笋笔笕笺笼笾筚筛筜筝筹筼签筿简箓箦箧箨箩箪箫篑篓篮篯篱簖籁籴类籼粜粝粤粪粮糁糇糍紧絷縆纟纠纡红纣纤纥约级纨纩纪纫纬纭纮纯纰纱纲纳纴纵纶纷纸纹纺纻纼纽纾线绀绁绂练组绅细织终绉绊绋绌绍绎经绐绑绒结绔绕绖绗绘给绚绛络绝绞统绠绡绢绣绤绥绦继绨绩绪绫绬续绮绯绰绱绲绳维绵绶绷绸绹绺绻综绽绾绿缀缁缂缃缄缅缆缇缈缉缊缋缌缍缎缏缐缑缒缓缔缕编缗缘缙缚缛缜缝缞缟缠缡缢缣缤缥缦缧缨缩缪缫缬缭缮缯缰缱缲缳缴缵罂网罗罚罢罴羁羟羡翘翙翚耢耧耸耻聂聋职聍联聩聪肃肠肤肮肴肾肿胀胁胆胧胨胪胫胶脉脍脏脐脑脓脔脚脱脶脸腊腌腘腭腻腼腽腾膑臜舆舣舰舱舻艰艳艺节芈芗芜芦苁苇苈苋苌苍苎苏茎茏茑茔茕茧荆荙荚荛荜荝荞荟荠荡荣荤荥荦荧荨荩荪荫荬荭荮药莅莱莲莳莴莶获莸莹莺莼萚萝萤营萦萧萨葱蒀蒇蒉蒋蒌蒏蓝蓟蓠蓣蓥蓦蔂蔷蔹蔺蔼蕰蕲蕴薮藓蘖虏虑虚虫虬虮虽虾虿蚀蚁蚂蚃蚕蚝蚬蛊蛎蛏蛮蛰蛱蛲蛳蛴蜕蜗蝇蝈蝉蝎蝼蝾螀螨蟏衅衔补衬衮袄袅袆袜袭袯装裆裈裢裣裤裥褛褴襕见观觃规觅视觇览觉觊觋觌觍觎觏觐觑觞触觯訚詟誉誊讠计订讣认讥讦讧讨让讪讫讬训议讯记讱讲讳讴讵讶讷许讹论讻讼讽设访诀证诂诃评诅识诇诈诉诊诋诌词诎诏诐译诒诓诔试诖诗诘诙诚诛诜话诞诟诠诡询诣诤该详诧诨诩诪诫诬语诮误诰诱诲诳说诵诶请诸诹诺读诼诽课诿谀谁谂调谄谅谆谇谈谉谊谋谌谍谎谏谐谑谒谓谔谕谖谗谘谙谚谛谜谝谞谟谠谡谢谣谤谥谦谧谨谩谪谫谬谭谮谯谰谱谲谳谴谵谶豮贝贞负贠贡财责贤败账货质贩贪贫贬购贮贯贰贱贲贳贴贵贶贷贸费贺贻贼贽贾贿赀赁赂赃资赅赆赇赈赉赊赋赌赍赎赏赐赑赒赓赔赕赖赗赘赙赚赛赜赝赞赟赠赡赢赣赪赵赶趋趱趸跃跄跞践跶跷跸跹跻踌踪踬踯蹑蹒蹰蹿躏躜躯车轧轨轩轪轫转轭轮软轰轱轲轳轴轵轶轷轸轹轺轻轼载轾轿辀辁辂较辄辅辆辇辈辉辊辋辌辍辎辏辐辑辒输辔辕辖辗辘辙辚辞辩辫边辽达迁过迈运还这进远违连迟迩迳迹选逊递逦逻遗遥邓邝邬邮邹邺邻郏郐郑郓郦郧郸酂酝酦酱酽酾酿释鉴銮錾钅钆钇针钉钊钋钌钍钎钏钐钑钒钓钔钕钖钗钘钙钚钛钜钝钞钟钠钡钢钣钤钥钦钧钨钩钪钫钬钭钮钯钰钱钲钳钴钵钶钷钸钹钺钻钼钽钾钿铀铁铂铃铄铅铆铇铈铉铊铋铌铍铎铏铐铑铒铓铔铕铖铗铘铙铚铛铜铝铞铟铠铡铢铣铤铥铦铧铨铩铪铫铬铭铮铯铰铱铲铳铴铵银铷铸铹铺铻铼铽链铿销锁锂锃锄锅锆锇锈锉锊锋锌锍锎锏锐锑锒锓锔锕锖锗锘错锚锛锜锝锞锟锠锡锢锣锤锥锦锧锨锩锪锫锬锭键锯锰锱锲锳锴锵锶锷锸锹锺锻锼锽锾锿镀镁镂镃镄镅镆镇镈镉镊镋镌镍镎镏镐镑镒镓镔镕镖镗镘镙镚镛镜镝镞镟镠镡镢镣镤镥镦镧镨镩镪镫镬镭镮镯镰镱镲镳镴镵镶长门闩闪闫闬闭问闯闰闱闲闳间闵闶闷闸闹闺闻闼闽闾闿阀阁阂阃阄阅阆阇阈阉阊阋阌阍阎阏阐阑阒阓阔阕阖阗阘阙阚阛队阳阴阵阶际陆陇陈陉陕陦陧陨险随隐隶隽难雇雏雠雳雾霁霡霭靓靔静靥鞑鞒鞯鞲韦韧韨韩韪韫韬韵页顶顷顸项顺须顼顽顾顿颀颁颂颃预颅领颇颈颉颊颋颌颍颎颏颐频颒颓颔颕颖颗题颙颚颛颜额颞颟颠颡颢颣颤颥颦颧风飏飐飑飒飓飔飕飖飗飘飙飚飞飨餍饣饤饥饦饧饨饩饪饫饬饭饮饯饰饱饲饳饴饵饶饷饸饹饺饻饼饽饾饿馀馁馂馃馄馅馆馇馈馉馊馋馌馍馎馏馐馑馒馓馔馕马驭驮驯驰驱驲驳驴驵驶驷驸驹驺驻驼驽驾驿骀骁骂骃骄骅骆骇骈骉骊骋验骍骎骏骐骑骒骓骔骕骖骗骘骙骚骛骜骝骞骟骠骡骢骣骤骥骦骧髅髋髌鬓鬶魇魉鱼鱽鱾鱿鲀鲁鲂鲃鲄鲅鲆鲇鲈鲉鲊鲋鲌鲍鲎鲏鲐鲑鲒鲓鲔鲕鲖鲗鲘鲙鲚鲛鲜鲝鲞鲟鲠鲡鲢鲣鲤鲥鲦鲧鲨鲩鲪鲫鲬鲭鲮鲯鲰鲱鲲鲳鲴鲵鲶鲷鲸鲹鲺鲻鲼鲽鲾鲿鳀鳁鳂鳃鳄鳅鳆鳇鳈鳉鳊鳋鳌鳍鳎鳏鳐鳑鳒鳓鳔鳕鳖鳗鳘鳙鳚鳛鳜鳝鳞鳟鳠鳡鳢鳣鳤鸟鸠鸡鸢鸣鸤鸥鸦鸧鸨鸩鸪鸫鸬鸭鸮鸯鸰鸱鸲鸳鸴鸵鸶鸷鸸鸹鸺鸻鸼鸽鸾鸿鹀鹁鹂鹃鹄鹅鹆鹇鹈鹉鹊鹋鹌鹍鹎鹏鹐鹑鹒鹓鹔鹕鹖鹗鹘鹙鹚鹛鹜鹝鹞鹟鹠鹡鹢鹣鹤鹥鹦鹧鹨鹩鹪鹫鹬鹭鹮鹯鹰鹱鹲鹳鹴鹾麦麸麹麺黄黉黡黩黪黾鼋鼌鼍鼹齐齑齿龀龁龂龃龄龅龆龇龈龉龊龋龌龙龚龛龟鿎鿏鿒鿔");
  const TRADITIONAL_ONLY_CHARS = new Set("㑯㑳㑶㓨㗲㘚㜄㜏㜢㠏㠣㥮㩜㩳㩵㺏䁪䁻䃮䊷䋙䋚䋹䋻䍦䎱䓣䙡䜀䝼䡵䥇䥑䥕䥱䦛䦟䧢䮄䯀䰾䱷䱽䲁䲘䴉丟並亂亙亞佇佈佔併來侖侶侷俁係俔俠俥俬倀倆倈倉個們倖倫倲偉偑側偵偽傌傑傖傘備傢傭傯傳傴債傷傾僂僅僉僑僕僞僤僥僨僱價儀儁儂億儈儉儎儐儔儕儘償優儲儷儸儺儻儼兇兌兒兗內兩冊冑冪凈凍凜凱別刪剄則剋剎剗剛剝剮剴創剷劃劄劇劉劊劌劍劏劑劚勁動務勛勝勞勢勣勩勱勳勵勸勻匭匯匱區協卹卻卽厙厠厤厭厲厴參叄叢吒吳吶呂咼員唄唸問啓啞啟啢喎喚喪喫喬單喲嗆嗇嗊嗎嗚嗩嗰嗶嘆嘍嘓嘔嘖嘗嘜嘩嘮嘯嘰嘵嘸嘽噁噓噚噝噠噥噦噯噲噴噸噹嚀嚇嚌嚐嚕嚙嚥嚦嚧嚨嚮嚲嚳嚴嚶囀囁囂囅囈囉囌囑囪圇國圍園圓圖團垻埡埨埰執堅堊堖堝堯報場塊塋塏塒塗塚塢塤塵塸塹塿墊墜墠墮墰墳墶墻墾壇壋壎壓壗壘壙壚壜壞壟壠壢壩壪壯壺壼壽夠夢夥夾奐奧奩奪奬奮奼妝姍姦娙娛婁婦婭媧媯媰媼媽嫋嫗嫵嫺嫻嫿嬀嬃嬈嬋嬌嬙嬡嬤嬪嬰嬸孃孋孌孫學孻孿宮寀寢實寧審寫寬寵寶將專尋對導尷屆屍屓屜屢層屨屬岡峯峴島峽崍崑崗崙崢崬嵐嵗嵽嵾嶁嶄嶇嶔嶗嶠嶢嶧嶨嶮嶸嶺嶼嶽巋巒巔巖巘巰巹帥師帳帶幀幃幓幗幘幟幣幫幬幷幹幾庫廁廂廄廈廎廕廚廝廞廟廠廡廢廣廩廬廳弒弔弳張強彄彆彈彌彎彔彙彠彥彫彲彿後徑從徠復徵徹恆恥悅悞悵悶悽惡惱惲惻愛愜愨愴愷愾慄態慍慘慚慟慣慤慪慫慮慳慶慺慼慾憂憊憐憑憒憖憚憤憫憮憲憶懇應懌懍懞懟懣懤懨懲懶懷懸懺懼懾戀戇戔戧戩戰戱戲戶扞拋挩挱挾捨捫捱捲掃掄掆掗掙掛採揀揚換揮揯損搖搗搧搵搶摑摜摟摯摳摶摺摻撈撏撐撓撝撟撣撥撫撲撳撻撾撿擁擄擇擊擋擓擔據擠擡擣擬擯擰擱擲擴擷擺擻擼擽擾攄攆攏攔攖攙攛攜攝攢攣攤攪攬敎敓敗敘敵數斂斃斆斕斬斷於旂旣昇時晉晛晝暈暉暐暘暢暫曄曆曇曉曏曖曠曥曨曬書會朥朧朮東枴柵柺査桱桿梔梘梜條梟梲棄棊棖棗棟棡棧棲棶椏椲楊楓楨業極榘榦榪榮榲榿構槍槓槤槧槨槮槳槶槼樁樂樅樑樓標樞樢樣樧樫樳樸樹樺樿橈橋機橢橫橯檁檉檔檜檟檢檣檮檯檳檸檻櫃櫍櫓櫚櫛櫝櫞櫟櫥櫧櫨櫪櫫櫬櫱櫳櫸櫻欄欅權欏欒欓欖欞欽歎歐歟歡歲歷歸歿殘殞殤殨殫殭殮殯殰殲殺殻殼毀毆毿氂氈氌氣氫氬氳氾汎汙決沒沖況泝洩洶浹浿涇涗涼淒淚淥淨淩淪淵淶淺渙減渢渦測渾湊湋湞湧湯溈準溝溫溮溳溼滄滅滌滎滙滬滯滲滷滸滻滾滿漁漊漍漚漢漣漬漲漵漸漿潁潑潔潕潙潚潛潤潯潰潷潿澀澆澇澐澗澠澤澦澩澫澮澱澾濁濃濄濆濕濘濚濛濜濟濤濧濫濰濱濺濼濾瀂瀅瀆瀇瀉瀋瀏瀕瀘瀝瀟瀠瀦瀧瀨瀰瀲瀾灃灄灑灒灕灘灙灝灡灣灤灧灩災為烏烴無煉煒煙煢煥煩煬煱熅熒熗熰熱熲熾燀燁燈燉燒燖燙燜營燦燬燭燴燶燻燼燾爍爐爛爭爲爺爾牀牆牘牴牽犖犛犢犧狀狹狽猙猶猻獁獃獄獅獎獨獪獫獮獰獱獲獵獷獸獺獻獼玀現琱琺琿瑋瑒瑣瑤瑩瑪瑲璉璊璕璗璡璣璦璫璯環璵璸璽璿瓅瓊瓏瓔瓚瓛甌甕產産畝畢畫異畵當疇疊痙痠痾瘂瘋瘍瘓瘞瘡瘧瘮瘲瘺瘻療癆癇癉癒癘癟癡癢癤癥癧癩癬癭癮癰癱癲發皁皚皰皸皺盃盜盞盡監盤盧盪眞眥眾睍睏睜睞瞘瞜瞞瞶瞼矇矓矚矯硃硜硤硨硯碕碩碭碸確碼碽磑磚磠磣磧磯磽磾礄礎礐礙礦礪礫礬礱祕祿禍禎禕禡禦禪禮禰禱禿秈稅稈稏稜稟種稱穀穇穌積穎穠穡穢穩穫穭窩窪窮窯窵窶窺竄竅竇竈竊竪競筆筍筧筴箇箋箏箚節範築篋篔篠篢篤篩篳篸簀簍簑簞簡簣簫簹簽簾籃籅籌籔籙籛籜籟籠籤籩籪籬籮籲粵糉糝糞糧糰糲糴糶糹糾紀紂紃約紅紆紇紈紉紋納紐紓純紕紖紗紘紙級紛紜紝紞紡紬紮細紱紲紳紵紹紺紼紿絀終絃組絅絆絎結絕絛絝絞絡絢給絨絪絰統絲絳絶絹絺綁綃綄綆綈綉綌綎綏綐綑經綖綜綝綞綠綡綢綣綧綪綫綬維綯綰綱網綳綴綵綸綹綺綻綽綾綿緄緇緊緋緑緒緓緔緗緘緙線緝緞締緡緣緦編緩緬緯緱緲練緶緹緻緼縈縉縊縋縐縑縕縗縛縝縞縟縣縧縫縭縮縯縱縲縳縴縵縶縷縹總績繃繅繆繒織繕繚繞繡繢繩繪繫繭繮繯繰繳繶繸繹繻繼繽繾繿纁纆纇纈纊續纍纏纓纔纕纖纘纜缽罃罈罌罎罰罵罷羅羆羈羋羣羥羨義羶習翫翬翹翽耬耮聖聞聯聰聲聳聵聶職聹聽聾肅脅脈脛脣脩脫脹腎腖腡腦腫腳腸膃膕膚膞膠膢膩膽膾膿臉臍臏臘臚臟臠臢臥臨臺與興舉舊舖舘艙艤艦艫艱艷芻茲荊莊莖莢莧華菴菸萇萊萬萴萵葉葒葤葦葯葷蒍蒐蒓蒔蒕蒞蒼蓀蓆蓋蓮蓯蓴蓽蔄蔔蔘蔞蔣蔥蔦蔭蔯蔿蕁蕆蕎蕒蕓蕕蕘蕢蕩蕪蕭蕷薀薈薊薌薑薔薘薟薦薩薳薴薵薹薺藍藎藝藥藪藭藴藶藹藺蘀蘄蘆蘇蘊蘋蘚蘞蘟蘢蘭蘺蘿虆虉處虛虜號虧虯蛺蛻蜆蝀蝕蝟蝦蝨蝸螄螞螢螮螻螿蟄蟈蟎蟣蟬蟯蟲蟳蟶蟻蠁蠅蠆蠍蠐蠑蠔蠟蠣蠨蠱蠶蠻衆衊術衕衚衛衝袞袷裊裏補裝裡製複褌褘褲褳褸褻襀襇襉襏襖襝襠襤襪襬襯襲襴覈見覎規覓視覘覡覥覦親覬覯覲覷覺覽覿觀觴觶觸訁訂訃計訊訌討訏訐訒訓訕訖託記訛訝訟訢訣訥訩訪設許訴訶診註証詀詁詆詎詐詒詔評詖詗詘詛詝詞詠詡詢詣試詩詪詫詬詭詮詰話該詳詵詷詼詿誄誅誆誇誌認誑誒誕誘誚語誠誡誣誤誥誦誨說説誰課誶誹誼誾調諂諄談諉請諍諏諑諒諓論諗諛諜諝諞諟諡諢諤諦諧諫諭諮諱諲諳諴諶諷諸諺諼諾謀謁謂謄謅謊謎謏謐謔謖謗謙謚講謝謠謡謨謫謬謭謳謹謾譁證譎譏譓譖識譙譚譜譞譟譫譭譯議譴護譸譽譾讀讅變讋讌讎讒讓讕讖讚讜讞谿豈豎豐豔豬豶貍貓貙貝貞貟負財貢貧貨販貪貫責貯貰貲貳貴貶買貸貺費貼貽貿賀賁賂賃賄賅資賈賊賑賒賓賕賙賚賜賞賠賡賢賣賤賦賧質賫賬賭賰賴賵賺賻購賽賾贄贅贇贈贊贋贍贏贐贓贔贖贗贛贜赬趕趙趨趲跡踐踰踴蹌蹕蹟蹠蹣蹤蹺躂躉躊躋躍躎躑躒躓躕躚躡躥躦躪軀車軋軌軍軏軑軒軔軛軝軟軤軫軲軸軹軺軻軼軾較輄輅輇輈載輊輋輒輓輔輕輗輛輜輝輞輟輥輦輩輪輬輮輯輳輶輸輻輼輾輿轀轂轄轅轆轉轍轎轔轟轡轢轤辦辭辮辯農迴逕這連週進遊運過達違遙遜遞遠遡適遲遶遷選遺遼邁還邇邊邏邐郟郵鄆鄉鄒鄔鄖鄧鄩鄭鄰鄲鄳鄴鄶鄺酇酈醃醖醜醞醟醣醫醬醱醲釀釁釃釅釋釐釒釓釔釕釗釘釙針釣釤釦釧釩釴釵釷釹釺釾釿鈀鈁鈃鈄鈅鈇鈈鈉鈍鈎鈐鈑鈒鈔鈕鈞鈡鈣鈥鈦鈧鈮鈰鈳鈴鈷鈸鈹鈺鈽鈾鈿鉀鉅鉆鉈鉉鉊鉋鉍鉑鉕鉗鉚鉛鉝鉞鉢鉤鉥鉦鉧鉬鉭鉮鉳鉶鉷鉸鉺鉻鉿銀銃銅銈銍銑銓銖銘銚銛銜銠銣銥銦銨銩銪銫銬銱銳銶銷銹銻銼鋁鋃鋅鋇鋌鋏鋐鋒鋗鋙鋝鋟鋣鋤鋥鋦鋨鋩鋪鋭鋮鋯鋰鋱鋶鋸鋹鋼錀錁錄錆錇錈錏錐錒錕錘錙錚錛錞錟錠錡錢錤錦錨錩錫錮錯録錳錶錸錼鍀鍁鍃鍅鍆鍇鍈鍊鍋鍍鍔鍘鍚鍛鍠鍤鍥鍩鍬鍭鍰鍵鍶鍺鍼鍾鎂鎄鎇鎊鎌鎓鎔鎖鎘鎚鎛鎝鎡鎢鎣鎦鎧鎩鎪鎬鎭鎮鎰鎲鎳鎵鎶鎸鎿鏃鏇鏈鏌鏍鏏鏐鏑鏗鏘鏜鏝鏞鏟鏡鏢鏤鏨鏰鏵鏷鏹鏺鏻鏽鐃鐄鐇鐋鐍鐏鐐鐒鐓鐔鐘鐙鐝鐠鐥鐦鐧鐨鐩鐫鐮鐯鐲鐳鐵鐶鐸鐺鐽鐿鑄鑊鑌鑑鑒鑔鑕鑞鑠鑣鑥鑪鑭鑰鑱鑲鑷鑹鑼鑽鑾鑿钁钂長門閂閃閆閈閉開閌閎閏閑閒間閔閘閡閣閤閥閨閩閫閬閭閱閲閶閹閻閼閽閾閿闃闆闇闈闉闊闋闌闍闐闑闒闓闔闕闖關闞闠闡闢闤闥陘陝陞陣陰陳陸陽隉隊階隑隕際隤隨險隮隯隱隴隸隻雋雖雙雛雜雞離難雲電霑霢霧霽靂靄靆靈靉靚靜靝靦靨鞏鞝鞦鞽韁韃韆韉韋韌韍韓韙韜韝韞韻響頁頂頃項順頇須頊頌頍頎頏預頑頒頓頔頗領頜頠頡頤頦頫頭頮頰頲頴頵頷頸頹頻頽顆題額顎顏顒顓顔顗願顙顛類顢顥顧顫顬顯顰顱顳顴風颭颮颯颱颳颶颸颺颻颼飀飄飆飈飛飠飢飣飥飩飪飫飭飯飱飲飴飼飽飾飿餃餄餅餈餉養餌餎餏餑餒餓餕餖餗餘餚餛餜餞餡館餬餱餳餵餶餷餸餺餼餾餿饁饃饅饈饉饊饋饌饑饒饗饘饜饞饢馬馭馮馱馳馴馹馼駁駃駉駐駑駒駓駔駕駘駙駛駝駟駡駢駪駭駰駱駸駼駿騁騂騄騅騊騌騍騎騏騑騖騙騞騠騤騧騫騭騮騰騱騵騶騷騸騾驀驁驂驃驄驅驊驌驍驎驏驕驗驚驛驟驢驤驥驦驪驫骯髏髒體髕髖髮鬆鬍鬚鬢鬥鬧鬨鬩鬮鬱鬹魎魘魚魛魟魢魨魯魴魷魺鮀鮁鮃鮆鮈鮊鮋鮍鮎鮐鮑鮒鮓鮚鮜鮝鮞鮟鮠鮡鮣鮦鮪鮫鮭鮮鮳鮶鮸鮺鯀鯁鯇鯉鯊鯒鯔鯕鯖鯗鯛鯝鯡鯢鯤鯧鯨鯪鯫鯰鯴鯷鯻鯽鯿鰁鰂鰃鰆鰈鰉鰊鰌鰍鰏鰐鰒鰓鰛鰜鰟鰠鰣鰤鰥鰧鰨鰩鰭鰮鰱鰲鰳鰵鰶鰷鰹鰺鰻鰼鰾鱀鱂鱅鱇鱈鱉鱒鱔鱖鱗鱘鱚鱝鱟鱠鱣鱤鱧鱨鱭鱯鱲鱷鱸鱺鳥鳧鳩鳬鳲鳳鳴鳶鳾鴆鴇鴉鴒鴕鴛鴝鴞鴟鴣鴦鴨鴯鴰鴴鴷鴻鴿鵁鵂鵃鵏鵐鵑鵒鵓鵜鵝鵟鵠鵡鵪鵬鵮鵯鵰鵲鵷鵾鶄鶇鶉鶊鶓鶖鶘鶚鶠鶡鶥鶩鶪鶬鶯鶱鶲鶴鶹鶺鶻鶼鶿鷀鷁鷂鷄鷉鷊鷓鷖鷗鷙鷚鷟鷥鷦鷫鷭鷯鷲鷳鷴鷸鷹鷺鷽鸂鸇鸊鸌鸏鸑鸕鸘鸚鸛鸝鸞鹵鹹鹺鹼鹽麗麥麩麪麫麬麯麳麴麵麼麽黃黌點黨黲黴黶黷黽黿鼂鼉鼕鼴齊齋齎齏齒齔齕齗齘齙齜齟齠齡齣齦齧齪齬齮齯齲齶齷齼龍龎龐龑龔龕龜鿁鿓");
  // ── GENERATED:ZH-CHAR-SETS END ──

  const NON_CHINESE_LANG_PREFIX = /^(ja|ko)\b/i;

  // P1: 原 isTraditionalChinese 拆分為通用 detectTextLang(回傳語言類別) +
  //     target-aware isAlreadyInTarget(target=='zh-TW' 跳繁中、'zh-CN' 跳簡中、'en' 跳英文)。
  //     既有 isTraditionalChinese 保留為 alias,避免外部 reference 斷掉(spec / 字幕路徑等)。
  //
  // 回傳:'zh-Hant' | 'zh-Hans' | 'ja' | 'ko' | 'en' | 'other'
  //   - 'zh-Hant' = 繁體中文(cjk 多 + 沒簡體特徵字 / 繁體特徵字佔優)
  //   - 'zh-Hans' = 簡體中文(cjk 多 + 簡體特徵字佔優 / 簡體比例 ≥ 0.2)
  //   - 'ja' / 'ko' = htmlLang 明示
  //   - 'en' = 主要 ASCII letter,cjk 比例 < 0.05
  //   - 'other' = 其他狀況(短文字 / 純符號 / 多語混雜等)
  //
  // v1.9.15 雙向偵測:同時統計 simp + trad 命中數,任一邊乾淨優先 short-circuit。
  // 既有比例 fallback(simp/cjk ≥ 0.2)維持,確保「短文補字策略」(v0.76)不被破壞。
  SK.detectTextLang = function detectTextLang(text) {
    const htmlLang = document.documentElement.lang || '';
    if (/^ja\b/i.test(htmlLang)) return 'ja';
    if (/^ko\b/i.test(htmlLang)) return 'ko';

    const lettersOnly = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (lettersOnly.length === 0) return 'other';

    let cjkCount = 0;
    let simpCount = 0;
    let tradCount = 0;  // v1.9.15 雙向偵測:繁體特徵字命中數
    let kanaCount = 0;
    let hangulCount = 0;
    let asciiLetterCount = 0;

    for (const ch of lettersOnly) {
      const code = ch.codePointAt(0);
      if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
        cjkCount++;
        if (SIMPLIFIED_ONLY_CHARS.has(ch)) simpCount++;
        if (TRADITIONAL_ONLY_CHARS.has(ch)) tradCount++;
      } else if ((code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) {
        kanaCount++;
      } else if (code >= 0xAC00 && code <= 0xD7AF) {
        // P1 v1.8.59:hangul Unicode 區段(韓文音節)
        hangulCount++;
      } else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
        asciiLetterCount++;
      }
    }

    // hangul 比例 > 5% → 視為韓文
    if (hangulCount > 0 && hangulCount / lettersOnly.length > 0.05) return 'ko';
    // 假名比例 > 5% → 視為日文(跟原 isTraditionalChinese 邏輯一致)
    if (kanaCount > 0 && kanaCount / lettersOnly.length > 0.05) return 'ja';

    const cjkRatio = cjkCount / lettersOnly.length;
    if (cjkRatio >= 0.5) {
      // v1.9.15:雙向強訊號優先 short-circuit。任一邊「乾淨」即直接判定,
      // 不再受 0.2 比例門檻拖累(對應「SC 文章但簡體比例 < 0.2」誤判案例)。
      if (simpCount > 0 && tradCount === 0) return 'zh-Hans';
      if (tradCount > 0 && simpCount === 0) return 'zh-Hant';
      // 兩邊都命中(混合) / 都沒命中(純人名數字)→ 走既有比例邏輯
      if (cjkCount > 0 && simpCount / cjkCount >= 0.2) return 'zh-Hans';
      return 'zh-Hant';
    }

    // 主要是 ASCII letter(包括英 / 西 / 法 / 德等所有拉丁字母語言)
    // 文字級無法區分這些語言(都是 ASCII letter),統一回 'en' 作為「拉丁字母 letter-dominant」識別。
    // isAlreadyInTarget 對 es/fr/de target 一律 return false(讓 LLM 端處理 echo / 翻譯判斷)。
    if (cjkRatio < 0.05 && asciiLetterCount / lettersOnly.length >= 0.5) return 'en';

    return 'other';
  };

  // 簡繁本地轉換的可轉換判定(translatePage convertOnly 過濾與 translateUnits
  // 分流共用的單一資料源)。不沿用 detectTextLang 的「主導語言」語意——那條的
  // cjkRatio ≥ 0.5 門檻會把「视频｜正面对决!大疆 OSMO nano 和影石 GO Ultra」
  // 這類英文品牌字母數壓過 CJK 的中英混排標題判成 'other',整條漏轉。轉換只動
  // CJK 字、對 ASCII 零影響,判準應是「CJK 部分夠多且乾淨屬於相反變體」:
  //   - detectTextLang 已判為相反變體 → 直接可轉(強訊號)
  //   - 否則放寬:CJK ≥ 2 字、CJK 佔字母數 ≥ 0.3(擋「英文長句夾帶兩個中文詞」
  //     ——那種 ratio 趨近 0,該整句送 LLM 翻成中文,不是只轉那兩個詞),且變體
  //     特徵字單邊乾淨。下限 2 不是 4:「传感/MEMS」這類 2 字 CJK + 英文縮寫的
  //     分類標籤(ratio 0.33)是真實漏轉案例,ratio 門檻已足以擋英文長句
  SK.isConvertibleVariant = function isConvertibleVariant(text, direction) {
    if (direction !== 'cn2twp' && direction !== 'twp2cn') return false;
    const wantLang = direction === 'cn2twp' ? 'zh-Hans' : 'zh-Hant';
    if (SK.detectTextLang(text) === wantLang) return true;
    const lettersOnly = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (lettersOnly.length === 0) return false;
    let cjkCount = 0, simpCount = 0, tradCount = 0;
    for (const ch of lettersOnly) {
      const code = ch.codePointAt(0);
      if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
        cjkCount++;
        if (SIMPLIFIED_ONLY_CHARS.has(ch)) simpCount++;
        if (TRADITIONAL_ONLY_CHARS.has(ch)) tradCount++;
      }
    }
    if (cjkCount < 2 || cjkCount / lettersOnly.length < 0.3) return false;
    return direction === 'cn2twp'
      ? (simpCount > 0 && tradCount === 0)
      : (tradCount > 0 && simpCount === 0);
  };

  // P1: target-aware「源語言已等於目標語言」判定。
  //   target='zh-TW' → 跳 'zh-Hant'(維持 v1.8.58 之前行為)
  //   target='zh-CN' → 跳 'zh-Hans'
  //   target='en'    → 跳 'en'(主要 ASCII letter)
  //   target='ja'    → 跳 'ja'(假名比例 > 5%)
  //   target='ko'    → 跳 'ko'(hangul 比例 > 5%)
  //   target='es' / 'fr' / 'de' → 一律 false(拉丁字母文字級無法區分,讓 LLM 端處理 echo)
  //   不認得的 target 一律 false(不跳,送 LLM 翻)。
  SK.isAlreadyInTarget = function isAlreadyInTarget(text, target) {
    const detected = SK.detectTextLang(text);
    if (target === 'zh-TW') return detected === 'zh-Hant';
    if (target === 'zh-CN') return detected === 'zh-Hans';
    if (target === 'en')    return detected === 'en';
    if (target === 'ja')    return detected === 'ja';
    if (target === 'ko')    return detected === 'ko';
    // es / fr / de:文字級無法區分,return false(送 LLM 處理)
    return false;
  };

  // P1: 既有 isTraditionalChinese 保留為 zh-TW 專用 alias(spec / 字幕路徑等仍 reference)。
  // 行為等同 isAlreadyInTarget(text, 'zh-TW')。
  SK.isTraditionalChinese = function isTraditionalChinese(text) {
    return SK.isAlreadyInTarget(text, 'zh-TW');
  };

  // 輸出語言守門判定(注入入口 SK.injectTranslation 呼叫的單一資料源)。
  // 譯文語言明顯 ≠ 目標語言時回 true → caller 不注入,保留原文,避免使用者看到與
  // 目標語言不符的字。只守「高把握、零誤判」方向:目標是拉丁字母語言(en/es/fr/de)
  // 但整段譯文是東亞文字(CJK 表意 / 假名 / 韓文音節)。實測 Gemini Flash Lite 對混語
  // 頁面(例如頁內夾中文 cookie 同意橫幅)偶發把德文段掉回中文,temperature=1.0 隨機性
  // 使其間歇出現;此守門把「拉丁 target 收到 CJK 輸出」這種必為 LLM 掉語言的段落擋掉。
  //
  // 為何不走 detectTextLang:它開頭用頁面 documentElement.lang 短路(ja/ko 頁一律回
  // ja/ko),在「翻譯日文頁 → 德文」時會把正確德文誤判成 ja。這裡自數 East-Asian 字元
  // 比例、完全不看 htmlLang,對拉丁 target 的正常譯文(ea≈0)零誤判、門檻 0.5 有巨大 margin。
  //
  // 反方向(CJK target 收到拉丁輸出 = echo 原文)不在此守:拉丁 target 未譯的專有名詞多、
  // 誤判風險高,交由 prompt 端 target-language reinforcement 處理。不認得的 target 一律 false。
  const LATIN_SCRIPT_TARGETS = new Set(['en', 'es', 'fr', 'de']);
  SK.isWrongLanguageOutput = function isWrongLanguageOutput(text, target) {
    if (!text || typeof text !== 'string') return false;
    if (!LATIN_SCRIPT_TARGETS.has(target)) return false;
    const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (letters.length === 0) return false;
    let ea = 0;
    for (const ch of letters) {
      const c = ch.codePointAt(0);
      if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)  // CJK 表意
          || (c >= 0x3040 && c <= 0x30FF)                              // 平假名 / 片假名
          || (c >= 0xAC00 && c <= 0xD7AF)) {                           // 韓文音節
        ea++;
      }
    }
    return ea / letters.length >= 0.5;
  };

  const _CJK_RE = /[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/;
  function _buttonThreshold(text) { return _CJK_RE.test(text) ? 3 : 8; }

  // 讀 element 自身或最近 ancestor 的 lang attribute,return lowercase or null。
  // 用於 isCandidateText 對社群網站(Twitter / Reddit / Threads / Mastodon / Discord web)的
  // lang attribute 信號優先於純文字 detect — short text(< 30 cjk)時 SIMP 集合命中率
  // 跨不過 0.2 閾值會被誤判 zh-Hant skip,但 Twitter 等站對每則內容都標 lang(simp tweet
  // 標 "zh"、繁中 tweet 標 "zh-TW"/"zh-Hant"),用此信號可 robust 判斷。
  function getElementLangHint(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      // 批次 8 A7:跳過「自家注入蓋的 lang」——applyTargetLocaleStyling 對已翻譯元素
      // 蓋 lang=target(同元素必帶 data-shinkansen-translated)。晚載進已譯容器的新
      // 內容會繼承這個 lang,把我們自己的標記當站點語言訊號會誤判「已是 target」skip
      // (scoped rescan 收不到)。帶 translated 標記的祖先其 lang 非站點訊號,繼續往上爬。
      const _skStamped = cur.hasAttribute && cur.hasAttribute('data-shinkansen-translated');
      if (!_skStamped) {
        // 只在 .lang 為字串時採用:HTMLFormElement 帶 [LegacyOverrideBuiltIns],
        // 若表單內有 name="lang" 的控制項,form.lang 會被該控制項(element)遮蓋而非回傳字串
        // (WordPress email-subscriptions form 實例),直接 .toLowerCase() 會 throw。
        // 非字串時 fall through 到 getAttribute('lang')(永遠回字串或 null)。
        if (typeof cur.lang === 'string' && cur.lang) return cur.lang.toLowerCase();
        const attr = cur.getAttribute && cur.getAttribute('lang');
        if (attr) return attr.toLowerCase();
      }
      cur = cur.parentElement;
    }
    return null;
  }
  // 暴露給 spec 用
  SK._getElementLangHint = getElementLangHint;

  // 對應 target,根據 lang attribute 決定是否「已是目標語言」(skip)或「明確需要翻」。
  // 回傳:'skip'(明確已是 target)/ 'translate'(明確需要翻)/ 'unknown'(無 hint 或 lang 不對應)
  // unknown 由 caller fallback 到純文字 detectTextLang。
  function langHintDecision(langHint, target) {
    if (!langHint) return 'unknown';
    // 規範化:zh-Hant / zh-TW / zh-HK / zh-MO 都視為 zh-Hant 系列;
    //         zh / zh-Hans / zh-CN / zh-SG 都視為 zh-Hans 系列(zh 無後綴 Twitter 對簡中標)。
    const isZhHant = /^zh-(hant|tw|hk|mo)$/i.test(langHint);
    const isZhHans = langHint === 'zh' || /^zh-(hans|cn|sg)$/i.test(langHint);
    if (target === 'zh-TW') {
      if (isZhHant) return 'skip';
      if (isZhHans) return 'translate';
    } else if (target === 'zh-CN') {
      if (isZhHans) return 'skip';
      if (isZhHant) return 'translate';
    } else if (target === 'en') {
      if (/^en\b/i.test(langHint)) return 'skip';
    } else if (target === 'ja') {
      if (/^ja\b/i.test(langHint)) return 'skip';
    } else if (target === 'ko') {
      if (/^ko\b/i.test(langHint)) return 'skip';
    }
    return 'unknown';
  }
  SK._langHintDecision = langHintDecision;

  function isCandidateText(el) {
    // v1.6.9: textContent 取代 innerText——innerText 觸發 layout 重算（每呼叫一次
    // 都 force layout reflow，在 leaf div/span 全頁掃描路徑會被呼叫上千次）。
    // textContent 純讀字串樹不 force layout。差異：textContent 包含 display:none
    // 子樹文字；但 isVisible 在多處已過濾隱藏祖先，剩餘 edge case 僅是「父可見、
    // 子隱藏」混排（極罕見），對長度/語言判斷不足以改變結果。
    const text = el.textContent?.trim();
    if (!text || text.length < 2) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    // P1: target-aware「已是目標語言」跳過。STATE.targetLanguage 由 content.js translatePage
    //     開始時從 storage 注入,預設 'zh-TW' 維持既有行為。
    const target = SK.STATE?.targetLanguage || 'zh-TW';
    // lang attribute hint 優先於純文字 detect:
    //   social 站(Twitter / Reddit / Threads / Mastodon)對每則內容標 lang;
    //   短簡中 tweet(< 30 cjk)SIMP 集合命中率跨不過 0.2 閾值會被誤判 zh-Hant skip。
    //   明確 lang attribute 信號比 SIMP 統計強得多,優先使用。沒 lang 的站維持純文字 detect。
    const langHint = getElementLangHint(el);
    const decision = langHintDecision(langHint, target);
    if (decision === 'skip') return false;
    if (decision === 'translate') return true;
    // unknown(沒 lang 或 lang 不對應)→ fallback 到純文字 detect
    if (SK.isAlreadyInTarget(text, target)) return false;
    return true;
  }

  // ─── 容器排除 ─────────────────────────────────────────

  function isContentFooter(el) {
    if (!el || el.tagName !== 'FOOTER') return false;
    if (el.querySelector('.wp-block-query, .wp-block-post-title, .wp-block-post')) return true;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (cur.tagName === 'ARTICLE' || cur.tagName === 'MAIN') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // 結構性 code 容器偵測：祖先 computed font-family 含等寬字眼且 white-space 為
  // pre 系列。這是所有 code rendering 共通的物理特徵（GitHub 新版 React 檔案瀏覽
  // 器 / GitLab / Bitbucket / VSCode Web / CodeMirror / Monaco / Prism / highlight.js
  // 都通用)，不依賴任何站點 class / id，符合硬規則 §6 / §8。
  // 兩條都成立才 reject——只 monospace 沒 pre 可能是 inline `<code>` 風格的小品味，
  // 一般文章正文不會兩條同時成立。
  const _MONOSPACE_FONT_RE = /(?:^|[\s,'"])(monospace|Menlo|Consolas|Monaco|Courier|Fira(?:\s+Code|\s+Mono)?|Source\s+Code|JetBrains|Cascadia|Roboto\s+Mono|SFMono|SF\s+Mono|ui-monospace)(?:[\s,'"]|$)/i;

  // 自然語言 inline 元素：出現在 <pre> 內表示是引用文字（Medium 留言等)，不是 code。
  const PROSE_INLINE_TAGS = new Set(['A', 'EM', 'STRONG', 'I', 'B', 'CITE', 'Q', 'MARK', 'SMALL', 'INS', 'DEL', 'U']);

  // v1.10.28: inline 格式化元素「直接」當 prose 容器的補抓選擇器。
  // <b>/<strong>/<i>/<em>/<u>/<font>/<mark>/<cite> 直接包整段文字(常以 <br> 分段),
  // 掛在非-block 容器(DIV 等)下,而其唯一 block 祖先已被結構性跳過時,既非
  // CONTAINER_TAGS(Case B/C)也非 SPAN(Case D/E)→ walker 非-block 分支全 miss、
  // leaf 補抓只收 div/span:not(:has(*)) 與 a → 完全漏抓。詳見 collectParagraphs 末段補抓。
  // 不含 A(由 leaf-content-anchor 處理)/ CODE / KBD / SAMP / VAR / SUB / SUP / TIME / ABBR
  //(這些非 prose 段落容器)。
  const INLINE_PROSE_WRAPPER_SELECTOR = 'b, strong, i, em, u, font, mark, cite';

  // 純識別符 cell 偵測：GitHub/GitLab/Bitbucket 檔案列表 filename 欄、版號、hash、
  // commit short id 之類字串翻譯後跟原文相同（`.github` → `.github`）或對中文讀者
  // 沒意義（`app` → `應用程式`，但 `app` 是檔名，翻了反而誤導)。wrapper 純粹是視覺
  // 垃圾。
  //
  // 結構性條件：文字只含 word char + dot + slash + hyphen + underscore + < 40 字。
  // 額外需滿足下列之一（防誤殺 plain 英文字 "Yes"/"Done"/"OK"):
  //   (a) 文字含 `.`/`/`/`-`(filename hint:`.github`/`v0.5.24`/`feat-x` 等)
  //   (b) cell 內含 svg/img 子（icon-label pattern：檔案夾 / 檔案 icon + 名稱)
  const PURE_IDENTIFIER_RE = /^[\w./\-]+$/;
  const FILENAME_HINT_RE = /[./\-]/;
  function isPureIdentifierCell(el) {
    const text = (el.textContent || '').trim();
    if (text.length === 0 || text.length >= 40) return false;
    if (!PURE_IDENTIFIER_RE.test(text)) return false;
    if (FILENAME_HINT_RE.test(text)) return true;
    if (el.querySelector('svg, img')) return true;
    return false;
  }

  // 日期 / 時間戳記 cell:GitHub commit 時間欄（`May 7, 2026` / `5 minutes ago` /
  // `last month`)、ISO date(`2026-05-07`）等格式。LLM 對短日期串容易 hallucinate
  // 出無關長文（觀察：`May 7, 2026` → 數百字 Microsoft 創辦故事)，且日期翻譯本身
  // 對中文讀者價值不高（`5 minutes ago` 已普及)，全部跳過。
  const DATE_PATTERNS = [
    // "May 7, 2026" / "Dec 12, 2024" / "September 3, 2025"
    /^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/,
    // "2026-05-07" / "2026/05/07" / "07-05-2026"
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,
    /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/,
    // Relative: "5 minutes ago" / "2 hours ago" / "3 days ago" / "last month"
    /^\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago$/i,
    /^last\s+(?:week|month|year)$/i,
    /^(?:yesterday|today|now)$/i,
    // 純時長： "5 minutes" / "3 days"
    /^\d+\s+(?:minute|hour|day|week|month|year)s?$/i,
  ];
  // review A8:acceptNode 對每個未被前置條件擋掉的元素都會呼叫 isDateLikeText,
  // 直接取 el.textContent 會把近 root wrapper 的整棵子樹文字 materialize——長頁
  // (1MB 文字、深度 20)每層 wrapper 各串接一次整頁文字,單次 collectParagraphs
  // 數十 MB 字串 churn,SPA rescan 還反覆跑。日期 cell 必近 leaf:先用
  // childElementCount 廉價早退,再用 TreeWalker 有界取樣(原始字元一超過 cap 就
  // 放棄——cap 遠大於日期字串連同縮排空白的實際長度),全程不串接整棵子樹。
  const _DATE_SAMPLE_CAP = 200;
  function _sampleShortText(el) {
    const doc = el.ownerDocument || document;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = '';
    let n;
    while ((n = walker.nextNode())) {
      out += n.nodeValue;
      if (out.length >= _DATE_SAMPLE_CAP) return null;
    }
    return out;
  }
  function isDateLikeText(el) {
    if (el.childElementCount > 3) return false;
    const sample = _sampleShortText(el);
    if (sample === null) return false;
    const text = sample.trim();
    if (text.length === 0 || text.length >= 30) return false;
    return DATE_PATTERNS.some((re) => re.test(text));
  }
  SK._isDateLikeText = isDateLikeText;  // 測試 seam(review A8 regression)
  function isCodeContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    // <pre> 有專屬規則（pre+code→skip,pre 單獨→當文字段落，例如 Medium 留言),
    // 不能被結構性 monospace 規則覆蓋。<pre> 的 UA 預設 white-space:pre + monospace
    // 字型剛好命中下面條件，但其語意應由 acceptNode 內 PRE+code 路徑（content-detect.js
    // 第 ~265 行）決定，不在此處判斷。
    if (el.tagName === 'PRE') return false;
    const cs = window.getComputedStyle(el);
    if (!cs) return false;
    const ws = cs.whiteSpace || '';
    if (ws !== 'pre' && ws !== 'pre-wrap' && ws !== 'break-spaces') return false;
    const ff = cs.fontFamily || '';
    return _MONOSPACE_FONT_RE.test(ff);
  }

  // v1.6.9: 加入 memo 參數做 per-call cache。原版每次從 el 走到 body
  // 是 O(depth)，在 walker acceptNode + 三條 querySelectorAll 補抓路徑被
  // 重複呼叫，實測同一個祖先鏈會被走過數百次。Map<el, bool> 把每個祖先
  // 第一次計算後的結果記下，後續任何後代命中即 O(1) 短路。memo 為純函式
  // 結果緩存（DOM 在單次 collectParagraphs 內不變動），語意完全等價。
  function isInsideExcludedContainer(el, memo) {
    if (memo && memo.has(el)) return memo.get(el);

    const visited = [];
    let cur = el;
    let result = false;
    while (cur && cur !== document.body) {
      if (memo && memo.has(cur)) {
        result = memo.get(cur);
        break;
      }
      visited.push(cur);

      const tag = cur.tagName;
      if (tag === 'FOOTER' && isContentFooter(cur)) {
        cur = cur.parentElement;
        continue;
      }
      // 簡繁轉換頁的 site footer 放行:footer / contentinfo 硬排除是「省 LLM
      // token」的成本政策,對免費本地轉換不適用——簡中頁全頁轉繁只剩頁尾留簡體
      // 視覺突兀。判準用內容自身(footer 文字是相反中文變體才放行,取樣 400 字),
      // 英文站 footer 不符合 → 排除照舊,LLM 成本政策不變。放行後 footer 內段落
      // 進正常收集與分流,可轉段落走免費轉換
      {
        const _role = cur.getAttribute && cur.getAttribute('role');
        if ((tag === 'FOOTER' || _role === 'contentinfo') && SK.isConvertibleVariant) {
          const _t = SK.STATE?.targetLanguage || 'zh-TW';
          const _dir = _t === 'zh-TW' ? 'cn2twp' : (_t === 'zh-CN' ? 'twp2cn' : null);
          if (_dir && SK.isConvertibleVariant((cur.textContent || '').slice(0, 400), _dir)) {
            cur = cur.parentElement;
            continue;
          }
        }
      }
      if (tag && SK.SEMANTIC_CONTAINER_EXCLUDE_TAGS.has(tag)) { result = true; break; }
      // v1.5.2: 祖先若是 dual 模式注入的譯文 wrapper，整段 skip。
      // acceptNode 流程已用 HARD_EXCLUDE_TAGS 擋住 wrapper 子樹，
      // 但 leaf content div/span / anchor / grid td 三條補抓路徑用
      // querySelectorAll 繞過 TreeWalker，必須在這裡再擋一次。
      if (tag === 'SHINKANSEN-TRANSLATION') { result = true; break; }
      // 結構性 code 容器排除（monospace + white-space:pre 系)。詳見 isCodeContainer
      // 註解。放在 SEMANTIC / SHINKANSEN 之後是因為較貴（getComputedStyle)，先讓
      // 便宜的 tag-based 比對短路。
      if (isCodeContainer(cur)) { result = true; break; }
      const role = cur.getAttribute && cur.getAttribute('role');
      if (role && SK.EXCLUDE_ROLES.has(role)) { result = true; break; }
      // banner 只在「HEADER tag + role 雙訊號」時排除(正規 masthead);單獨
      // role="banner" 的 DIV 常是被誤標的 hero 內容區,不排除(見 EXCLUDE_ROLES 註解)
      if (tag === 'HEADER' && role === 'banner') { result = true; break; }
      if (cur.getAttribute && cur.getAttribute('contenteditable') === 'true') { result = true; break; }
      if (role === 'textbox') { result = true; break; }
      cur = cur.parentElement;
    }

    if (memo) {
      for (const v of visited) memo.set(v, result);
    }
    return result;
  }

  function isInteractiveWidgetContainer(el) {
    const buttons = el.querySelectorAll('button, [role="button"]');
    if (buttons.length === 0) return false;
    // 程式碼區塊複製按鈕（GitHub `<clipboard-copy>` / 通用「button 跟 <pre> 同
    // 父層」結構）是 utility，不是父段落本身的互動。從 button 往上 walk，若任一
    // 層的兄弟元素含 <pre>，視為 code-block utility，從 widget 計數中剔除。
    //
    // v1.8.60: <a role="button"> 有真實 href(非 '#' / 'javascript:' / 空)→ 視為
    // navigation link,不算互動 widget(swiper carousel / Bootstrap nav-pills 慣例,
    // 把 role="button" 加在 nav anchor 上是 a11y 提示,並非真按鈕)。對應 upmedia.mg
    // 主選單(<li><a href="/tw/project/..." role="button">短文字</a></li>)case,
    // 沒這條 nav LI 整顆被 widget skip → 短中文 nav 翻不到。'#' / 'javascript:' /
    // 空 href 仍視為真 widget(SPA dropdown trigger / accordion toggle 等本質上
    // 不 navigate,只觸發 JS 行為)。
    //
    // v1.8.61: 進一步收緊 — `aria-haspopup="true"` 是 ARIA 標準明確聲明「會展開
    // popup / menu」,等同 dropdown trigger,即使 href 是真 URL 也維持 widget skip。
    // 對應 upmedia.mg 主選單真實結構(`<a role="button" aria-haspopup="true">頂層</a>
    // <div class="dropdown-menu"><a class="dropdown-item">子項</a>…</div>`):若不擋,
    // collectParagraphs 會把 LI 整顆收進候選,inject 譯文時嵌套 dropdown-menu 結構
    // 被破壞 → 全部子項平鋪展開亂版。Bootstrap / Headless UI / Reach UI 等任何符合
    // ARIA 的 dropdown 共用此屬性,屬結構性通則不是站點特判。
    let nonUtilityCount = 0;
    for (const btn of buttons) {
      if (btn.tagName === 'A' && btn.getAttribute('role') === 'button') {
        const ariaHaspopup = btn.getAttribute('aria-haspopup');
        const isPopupTrigger = ariaHaspopup && ariaHaspopup !== 'false';
        const href = btn.getAttribute('href');
        const hasRealHref = href && href !== '#' && !href.startsWith('javascript:');
        if (hasRealHref && !isPopupTrigger) continue;
      }
      let cur = btn;
      let isCodeUtility = false;
      while (cur && cur !== el && cur.parentElement) {
        const parent = cur.parentElement;
        for (const sib of parent.children) {
          if (sib === cur) continue;
          if (sib.tagName === 'PRE' || (sib.querySelector && sib.querySelector('pre'))) {
            isCodeUtility = true;
            break;
          }
        }
        if (isCodeUtility) break;
        cur = parent;
      }
      if (!isCodeUtility) nonUtilityCount++;
    }
    if (nonUtilityCount === 0) return false;
    // 2026-07-09:prose 段落內嵌註腳按鈕不是 widget 容器。bigfoot.js 類註腳 lib 會把
    // <sup><a rel="footnote"> 改造成 <div><button> 塞進 <p>，原本整段 P 被當互動
    // widget 跳過，一個字都翻不到(leancrew 實測，probe-leancrew-footnote.js 重現)。
    // 結構性區分(§8):widget 容器(工具列 / 卡片 / nav)的文字都住在子元素裡，
    // 直接 text node 幾乎為空；prose 段落的正文就是 el 自己的直接 text node。
    // 直接文字 >= 100 字 = prose 主體、按鈕只是內嵌註記 → 放行(序列化端 BUTTON 走
    // PRESERVE / reuse-node 佔位符，譯文注入後原按鈕 DOM 與事件監聽保留)。
    // 100 字門檻刻意高於 Case 系列的 20 字：短文字 + 按鈕的容器(toast / Follow 卡)
    // 維持 widget 跳過的既有行為。
    if (directTextLength(el) >= 100) return false;
    // v1.6.9: 此處刻意保留 innerText（不改 textContent）。語意上「>=300 字
    // 視為非 widget」要的是「使用者實際看得到的字數」，改成 textContent 會把
    // 隱藏 modal/menu/dropdown 的字也算進來，可能讓本應被視為 widget 的元件
    // 通過篩選被翻譯。Twitter / Gmail 這類站常見，風險過大。此函式只在 walker
    // accept 路徑被呼叫一次/element，非熱點。
    const textLen = (el.innerText || '').trim().length;
    if (textLen >= 300) return false;
    return true;
  }

  // v1.4.9 Case B helpers
  function hasBrChild(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') return true;
    }
    return false;
  }

  function directTextLength(el) {
    let total = 0;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) total += child.nodeValue.trim().length;
    }
    return total;
  }

  // Case D 用：el 是否有直接 element 子（BR 不算)。
  // 跟 hasBrChild 對稱：Case B 抓「BR + 純文字」,Case D 抓「inline element + 文字」。
  function hasDirectNonBrElement(el) {
    for (const child of el.childNodes) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.tagName === 'BR') continue;
      return true;
    }
    return false;
  }

  // Case D 用：祖先鏈是否已被某條路徑抽過 fragment。SPAN 嵌套（host > inner-span > a)
  // 在 YouTube / 通用 web 都很常見，父抽完後子的 walker visit 仍會發生（NodeFilter.FILTER_SKIP
  // 不阻擋 walker 訪問子節點)，不擋祖先會把同一段文字重複抽兩次，deserialize 時佔位符 slot
  // 對不上譯文。Case A/B/C 因為 CONTAINER_TAGS 限定 DIV/SECTION 等少嵌套 tag 沒踩到，
  // Case D 把 SPAN 納入後必須補上。
  //
  // v1.9.31: 加 block-boundary 邏輯 — 若 inner el 到 extracted ancestor 之間隔了一層
  // BLOCK tag (LI / P / 等),則 inner el 的內容不可能在 extracted ancestor 的 fragment 內
  // (extractInlineFragments 在 BLOCK 子孫處 flushRun,inline run 不會跨越 block 邊界)。
  // 真實 case: IG modal 留言 outer LI 因含 block 子孫 + 文字 >= 300 字走 containsBlockDescendant
  // 路徑(line 815)被加進 fragmentExtracted,內層 reply LI > 嵌套 DIV > SPAN[dir=auto] 的
  // Case D 會被原 hasAncestorExtracted 誤擋(outer LI 是祖先),但 UL/LI 已切斷 inline run,
  // inner SPAN 內容根本不在 outer LI 的 fragment 範圍內,擋住純粹是 over-block。
  function hasAncestorExtracted(el, fragmentExtracted) {
    let cur = el.parentElement;
    let crossedBlock = false;
    while (cur && cur !== document.body) {
      if (fragmentExtracted.has(cur)) {
        // 跨越 block 邊界後遇到的 extracted ancestor:其 fragment 用 inline-run 抽,
        // block 邊界把 inner el 隔在 fragment 外。繼續往上找。
        if (crossedBlock) { cur = cur.parentElement; continue; }
        return true;
      }
      if (SK.BLOCK_TAGS_SET.has(cur.tagName)) crossedBlock = true;
      cur = cur.parentElement;
    }
    return false;
  }

  // ─── Fragment 抽取 ────────────────────────────────────

  // opts(v2.0.79,媒體卡片路徑用;預設值 = 原本行為,既有 caller 不受影響):
  //   containerBoundary — CONTAINER_TAGS 子元素(DIV / SECTION…)一律當 run 邊界,
  //     不吸進 fragment。isInlineRunNode 對「不含 block 子孫的 DIV」回 true,一般
  //     inline 抽取靠這點把 wrapper 併進 run;但媒體卡片的內容區塊正是這些容器,
  //     吸進來等於把整張卡片當一段送翻(注入 clean-slate 會清掉 img),
  //     正是 mediaCardSkip 要防的事。
  //   requireDirectText — run 內「直屬 text node」至少 2 字才成 fragment。媒體卡片
  //     分支只負責撿 el 自己的直屬文字;純由 inline 元素構成的 run(圖示連結等)
  //     留給既有 leaf / Case A-E 路徑處理,避免重複收同一段文字。
  function extractInlineFragments(el, opts) {
    const containerBoundary = !!(opts && opts.containerBoundary);
    const requireDirectText = !!(opts && opts.requireDirectText);
    const fragments = [];
    const children = Array.from(el.childNodes);
    let runStart = null;
    let runEnd = null;

    const flushRun = () => {
      if (!runStart) return;
      let text = '';
      let n = runStart;
      while (n) {
        text += n.textContent || '';
        if (n === runEnd) break;
        n = n.nextSibling;
      }
      const trimmed = text.trim();
      // v1.2.0: 已翻譯成 target 語言的 fragment 不再重複收集
      // （fragment 注入後父元素不帶 data-shinkansen-translated，
      //   若不在此過濾，SPA observer rescan 會無限迴圈）
      // P1 (v1.8.59):從寫死 isTraditionalChinese 改成 target-aware ──
      //   原邏輯只考慮 target=zh-TW(只翻成繁中),target=en/zh-CN 時繁中原文(例如新聞標題)
      //   會被誤判「已是 target」直接跳掉,造成「target=en 但中文標題沒翻」的 bug。
      const _target = SK.STATE?.targetLanguage || 'zh-TW';
      if (trimmed.length >= 2 && SK.isAlreadyInTarget(trimmed, _target)) {
        runStart = null;
        runEnd = null;
        return;
      }
      // v2.0.52:改走 SK.hasSubstantiveText(單一資料源;原字面 regex 缺假名 / 諺文,
      // 純假名 inline run 不收集 → 日文頁對白永不翻)
      if (SK.hasSubstantiveText(text)) {
        let _elCount = 0, _wrapperEl = null, _directTextLen = 0;
        { let _n = runStart;
          while (_n) {
            if (_n.nodeType === 1) { _elCount++; _wrapperEl = _n; }
            else if (_n.nodeType === 3) { _directTextLen += (_n.textContent || '').trim().length; }
            if (_n === runEnd) break;
            _n = _n.nextSibling;
          }
        }
        // run 是「單一巢狀 wrapper 元素 + 長文」時跳過——原意:文字其實在 wrapper 內的
        // 巢狀結構(如商品卡 <a> 內含多層 DIV),該由 walker 遞迴處理而非當 inline fragment 抽。
        // v1.10.15:補 _directTextLen < 20。原條件用「整個 run 字數」判斷,沒扣掉「文字其實
        // 在直接 text node、wrapper 本身幾乎沒文字」的情況,誤殺「實質 prose 直接文字 + 一個
        // inline 媒體 wrapper」結構——典型 YouTube 留言 <span>長文字<span><img emoji></span>
        // 更多文字</span>:emoji wrapper 0 字、272 字全在直接 text node,卻被當「單一長巢狀
        // 元素」整則丟棄不翻。加 _directTextLen < 20:只有直接文字微不足道(文字真的在 wrapper
        // 巢狀結構內)才 skip;有實質直接 prose 時 wrapper 只是 inline 媒體 → 照常抽 fragment
        // (保留 img)。product-card 那種「wrapper 內巢狀、無直接文字」directText≈0 仍被擋。
        if (_elCount === 1 && _wrapperEl && _wrapperEl.children.length > 0 &&
            trimmed.length >= 100 && _directTextLen < 20) {
          runStart = null; runEnd = null;
          return;
        }
        if (requireDirectText && _directTextLen < 2) {
          runStart = null; runEnd = null;
          return;
        }
        fragments.push({
          kind: 'fragment',
          el,
          startNode: runStart,
          endNode: runEnd,
        });
      }
      runStart = null;
      runEnd = null;
    };

    for (const child of children) {
      const isBoundaryContainer = containerBoundary &&
        child.nodeType === Node.ELEMENT_NODE && SK.CONTAINER_TAGS.has(child.tagName);
      if (!isBoundaryContainer && SK.isInlineRunNode(child)) {
        if (!runStart) runStart = child;
        runEnd = child;
      } else {
        flushRun();
      }
    }
    flushRun();
    return fragments;
  }

  // v1.10.53: 把「純文字 + 多個 <br>、無 block 子孫」的超長 Case B 區塊,按段落邊界切成
  // 多個 fragment unit。段落邊界 = 連續 ≥2 個 <br>(中間夾的純空白 text node 視為分隔符的
  // 一部分);單一 <br> 視為段落內換行,留在 fragment 內(序列化時掃 startNode..endNode 會
  // 帶到它,轉成  → \n)。分隔用的 BR 群不納入任何 fragment,注入後留在原位 → 段落
  // 間距保留。回傳的 {kind:'fragment', el, startNode, endNode} 沿用 injectFragmentTranslation
  // 注入(同一 el 多 fragment 共存是 Case A 既有行為)。
  // 結構通則(§8):描述「雙 <br> = 段落分隔」的 DOM 結構特徵,不綁站點 / class。
  function splitBrBlock(el) {
    const fragments = [];
    const children = Array.from(el.childNodes);
    const isBr = (n) => n && n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR';
    const isWs = (n) => n && n.nodeType === Node.TEXT_NODE && !(n.nodeValue || '').trim();
    const _target = SK.STATE?.targetLanguage || 'zh-TW';

    let runStart = null;
    let runEnd = null;

    const flush = () => {
      if (!runStart) return;
      let text = '';
      let n = runStart;
      while (n) { text += n.textContent || ''; if (n === runEnd) break; n = n.nextSibling; }
      const trimmed = text.trim();
      // 已是 target 語言 / 無可翻字元的段落跳過(對齊 extractInlineFragments 的 flushRun 過濾;
      // v2.0.77 改走 SK.hasSubstantiveText 單一資料源——原字面 regex 缺假名 / 諺文,
      // 純假名段落被整段丟棄)
      if (trimmed.length >= 2 &&
          !SK.isAlreadyInTarget(trimmed, _target) &&
          SK.hasSubstantiveText(text)) {
        fragments.push({ kind: 'fragment', el, startNode: runStart, endNode: runEnd });
      }
      runStart = null;
      runEnd = null;
    };

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (isBr(child)) {
        // 往後看(跳過純空白)是否還有 BR → 連續 ≥2 = 段落邊界
        let j = i + 1;
        let brCount = 1;
        while (j < children.length && (isBr(children[j]) || isWs(children[j]))) {
          if (isBr(children[j])) brCount++;
          j++;
        }
        if (brCount >= 2) {
          flush();        // 結束當前段;整個 BR 群當分隔符,不納入任何 fragment
          i = j - 1;      // for 的 i++ 會再 +1,跳過整個 BR(含夾縫空白)群
          continue;
        }
        // 單一 <br>:段落內換行,不主動移動 runEnd——只要前後有意義節點,flush 的
        // startNode..endNode 掃描自然會帶到它
        continue;
      }
      if (isWs(child)) continue;  // 純空白 text node:同理不主動開 run
      // 有意義節點(非空 text / inline 元素)
      if (!runStart) runStart = child;
      runEnd = child;
    }
    flush();
    return fragments;
  }
  SK._splitBrBlock = splitBrBlock;  // 測試 seam

  // v1.10.56: 給「被主 walker 接受的 block 段落」(P / TD / BLOCKQUOTE…)找出真正帶
  // <br><br> 段落結構的容器。Case B(splitBrBlock)只跑在非-block CONTAINER_TAGS(DIV…),
  // 但 paulgraham.com 這類老站把整篇文章塞在單一 block <p> 裡、再包一層 <font> inline
  // wrapper,<br><br> 全在 <font> 內 → 主 walker 把整顆 <p> 當單一 ~2 萬字 unit,
  // thinking 模型 streaming『最後一段無法結束』/ 非串流 retry fetch timeout 整段 FAIL。
  // 此 helper 沿「唯一具意義 element 子、無直接可翻文字」的 inline wrapper 鏈下探(最多 3 層),
  // 找到自身帶直接 <br> 子的容器回傳;找不到回 null。
  // 結構通則(§8):描述「block 段落內容其實由內層 inline wrapper 用 <br><br> 分段」的 DOM
  // 巢狀特徵,不綁站點 / class / tag 身份(font 只是常見 carrier,span / b 同理)。
  function findBrSplitTarget(el) {
    let cur = el;
    for (let depth = 0; depth < 4; depth++) {
      if (hasBrChild(cur)) return cur;
      // 收集 cur 的「具意義」子:非空 text(直接可翻文字)或非 BR element
      let onlyChild = null;
      let hasDirectText = false;
      let multiple = false;
      for (const c of cur.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) {
          if ((c.nodeValue || '').trim().length >= 2) hasDirectText = true;
          continue;
        }
        if (c.nodeType !== Node.ELEMENT_NODE) continue;
        if (c.tagName === 'BR') continue;
        if (onlyChild) { multiple = true; break; }
        onlyChild = c;
      }
      // 有直接文字 / 多個 element 子 / 沒可下探的子 → 不是「單一 inline wrapper 包整段」結構
      if (hasDirectText || multiple || !onlyChild) return null;
      // 只穿越非-block inline wrapper(font / span / b / i…);遇 block 子(內層 P / DIV…)停手,
      // 那種結構會由各自的 walker 路徑分別收集,不該在這裡硬切。
      if (SK.BLOCK_TAGS_SET.has(onlyChild.tagName) || SK.CONTAINER_TAGS.has(onlyChild.tagName)) return null;
      cur = onlyChild;
    }
    return null;
  }
  SK._findBrSplitTarget = findBrSplitTarget;  // 測試 seam

  // ─── collectParagraphs ────────────────────────────────

  SK.collectParagraphs = function collectParagraphs(root, stats, opts) {
    root = root || document.body;
    stats = stats || null;
    // 批次 8 A7:opts.includeRoot——scoped rescan(SPA 對「已翻譯容器內晚載節點」
    // 以該節點為 root 補收)需要 root 自身也進候選:TreeWalker 依 spec 不對 root 跑
    // filter,晚載節點本身就是段落(如 <p>)時 scoped collect 會收 0。
    const includeRoot = !!(opts && opts.includeRoot);

    // ─── 殭屍轉換 marker reconcile ────────────────────────
    // target 為中文變體時,已標記元素的內容若仍偵測為「相反變體」,marker 必為
    // 殭屍——真轉換過的內容不可能仍是相反變體。成因(sspai SPA 實測):站內導航
    // 時 framework 重用 DOM 元素(文章 A 轉換後導到文章 B,元素同顆、文字換成 B
    // 的原文),resetForSpaNavigation 清了 STATE maps 但 marker 屬性留在元素上
    // → 新一輪收集「已標記一律跳過」→ 永遠停在原文,Content Guard 也無資料可修。
    // 這裡 unmark + 清 STATE 殘影,讓本輪照常收集重轉。dual 模式安全:dual 元素
    // 同時含原文與譯文,isConvertibleVariant 要求變體特徵單邊乾淨 → 不會命中。
    {
      const _t = SK.STATE?.targetLanguage || 'zh-TW';
      const _dir = _t === 'zh-TW' ? 'cn2twp' : (_t === 'zh-CN' ? 'twp2cn' : null);
      if (_dir && SK.isConvertibleVariant) {
        let _staleCount = 0;
        const _reconcileScope = (scope) => {
        for (const el of scope.querySelectorAll('[data-shinkansen-translated], [data-shinkansen-nodevalue-mutated]')) {
          if (el.getAttribute('contenteditable') === 'true') continue;      // 編輯模式不動
          if (el.hasAttribute('data-shinkansen-dual-source')) continue;     // dual 原文槽本就是原文
          if (el.querySelector('shinkansen-translation')) continue;        // dual wrapper 容器
          // review A9:全頁轉換後每個段落都帶 marker,每輪 rescan 對每個 marked
          // 元素取全文跑 isConvertibleVariant(內部兩趟字元掃描)≈ 每輪重掃整頁
          // 文字兩遍。比照 footer 放行(isInsideExcludedContainer)取樣 400 字——
          // 殭屍偵測只需變體特徵單邊乾淨,段落前 400 字足以判定
          const _txt = (el.textContent || '').slice(0, 400).trim();
          if (!_txt || !SK.isConvertibleVariant(_txt, _dir)) continue;
          el.removeAttribute('data-shinkansen-translated');
          el.removeAttribute('data-shinkansen-nodevalue-mutated');
          // 注入時 applyTargetLocaleStyling 蓋的 per-element lang=target 也要清,
          // 否則 isCandidateText 的 lang hint 會判「已是目標語言」直接 skip,
          // reconcile 白做。只清「值屬 target 家族」的 lang(站點自標的來源語言
          // lang 例 zh-CN 不動,hint 對它本就回 translate)
          const _elLang = el.getAttribute('lang');
          if (_elLang && langHintDecision(_elLang.toLowerCase(), _t) === 'skip') {
            el.removeAttribute('lang');
          }
          const S = SK.STATE;
          S.originalHTML?.delete?.(el);
          S.originalText?.delete?.(el);
          S.translatedHTML?.delete?.(el);
          S.nodeValueMutateBackup?.delete?.(el);
          S.nvMutateTranslation?.delete?.(el);
          _staleCount++;
        }
        };
        _reconcileScope(root);
        // open shadow root 內的元素同樣會被 framework 重用(下方 processScope 明確
        // 收集 shadow 內容),querySelectorAll 不穿 shadow boundary → 各 shadow root
        // 各跑一次,否則 shadow 內殭屍 marker 永不清、內容永遠停在原文(review A6)
        if (typeof SK.findOpenShadowRoots === 'function') {
          for (const _sr of SK.findOpenShadowRoots(root)) _reconcileScope(_sr);
        }
        if (_staleCount > 0) {
          SK.sendLog?.('info', 'detect', 'stale conversion markers reconciled (framework-reused elements unmarked)', { count: _staleCount });
          if (stats) stats.staleMarkerReconciled = _staleCount;
        }
      }
    }

    const results = [];
    const seen = new Set();
    const fragmentExtracted = new Set();
    const _foreignPage = (() => {
      // 翻譯 / 轉換成功後 applyDocTargetLang 會把 <html lang> 蓋成 target
      // (v2.0.73,對齊下游 scraper)。rescan 的 foreign 判定必須看「原始」宣告
      // (docLangBackup.orig),否則 SPA 晚載內容失去外語頁短文放寬——實例:
      // lang="zh" 的 SPA 首屏轉換後 lang 變 zh-TW,API 晚載的 12 字卡片標題
      // 被 20 字 anchor 門檻擋掉永遠不轉。orig 為 null(原頁無宣告)走 title 推導
      const _langBackup = SK.STATE?.docLangBackup;
      const hl = ((_langBackup ? (_langBackup.orig || '') : (document.documentElement.lang || '')) + '').toLowerCase();
      const t = SK.STATE?.targetLanguage || 'zh-TW';
      if (!hl) {
        // 無 lang 宣告的頁面:僅在「target 為中文變體且 title 文字級偵測為相反
        // 變體」時視為 foreign——簡中新聞站常不宣告 lang,原本一律保守 false 讓
        // 短 anchor(tag 標籤「传感/MEMS」等)過不了 leaf-anchor 的 20 字門檻永遠
        // 不轉。刻意只開這一種推導:相反中文變體是零誤判訊號(title 已含變體特徵
        // 字),其他語言組合(英文 title 等)維持原本保守行為——泛推導會讓英文
        // no-lang 頁的短文負向保護(nav 麵包屑 / username / Read More 短 DIV)
        // 整批翻盤,LLM 路徑成本語意跟免費轉換不同,不陪葬
        const detected = SK.detectTextLang(document.title || '');
        if (t === 'zh-TW' && detected === 'zh-Hans') return true;
        if (t === 'zh-CN' && detected === 'zh-Hant') return true;
        return false;
      }
      if (t === 'zh-TW' && /^zh-(hant|tw|hk|mo)$/i.test(hl)) return false;
      if (t === 'zh-CN' && (hl === 'zh' || /^zh-(hans|cn|sg)$/i.test(hl))) return false;
      if (t !== 'zh-TW' && t !== 'zh-CN') {
        if (hl.startsWith(t.split('-')[0].toLowerCase())) return false;
      }
      return true;
    })();
    // v1.6.9: per-call memo for isInsideExcludedContainer。整個 collectParagraphs
    // 期間 DOM 不變，同一祖先鏈只算一次。
    const excludedMemo = new Map();
    // v1.8.14: 補抓三條（leaf anchor / leaf div span / 等）共用的「BLOCK 祖先」memo。
    // 之前每條補抓路徑各自從葉節點 walk 到 body，大頁面浪費上千次祖先比對。
    const blockAncestorMemo = new Map();
    // v1.9.31: walker 期間用 interactiveWidget reject 掉的 block element 集合。
    // hasBlockAncestor 走訪時若祖先在此集合內,視為「不算 block 祖先」,讓 leaf
    // 補抓 path 可以撈出 widget-reject block 內藏的長文 leaf(典型場景:Instagram
    // modal photo viewer 留言 — 結構是 UL > DIV[role=button] > LI > 嵌套 DIV >
    // SPAN[dir=auto] 留言文字,LI 內含 reply / like / more 等真實 button →
    // walker reject 整顆 LI subtree,但 leaf SPAN 是純 prose 應該翻)。
    // memo 安全:widgetRejectedBlocks 在 walker 跑完才被讀(補抓 path 都在 walker
    // 之後),walker 期間不會用到 hasBlockAncestor。
    const widgetRejectedBlocks = new Set();
    const structurallySkippedBlocks = new Set();
    const shortBlockRejectedBlocks = new Set();
    function hasBlockAncestor(el) {
      if (blockAncestorMemo.has(el)) return blockAncestorMemo.get(el);
      const chain = [];
      let cur = el.parentElement;
      let result = false;
      while (cur && cur !== document.body) {
        if (blockAncestorMemo.has(cur)) {
          result = blockAncestorMemo.get(cur);
          break;
        }
        chain.push(cur);
        if (SK.BLOCK_TAGS_SET.has(cur.tagName) &&
            !widgetRejectedBlocks.has(cur) &&
            !structurallySkippedBlocks.has(cur)) {
          result = true;
          break;
        }
        cur = cur.parentElement;
      }
      for (const node of chain) blockAncestorMemo.set(node, result);
      blockAncestorMemo.set(el, result);
      return result;
    }

    // v1.9.13: open Shadow DOM 支援。walker + 4 條補抓抽進 processScope，
    // 主 root(document.body)跑一次,再對 root subtree 內每個 open shadow root
    // 各跑一次。closed shadow root 受 web spec 限制無法 traverse,直接跳過。
    // 共用 seen / excludedMemo / fragmentExtracted / blockAncestorMemo,避免 host
    // 與 shadow 重複計算或 inject 衝突。
    function processScope(scopeRoot, _includeRootCandidate) {
    const _walkerFilter = {
      acceptNode(el) {
        // BUTTON 放行:CJK >= 3 字 / non-CJK >= 8 字視為有意義的文字內容,
        // SKIP 讓 walker 進子節點,由後段補抓 leaf。
        // 極短 BUTTON（「送信」2 字 / "OK" 2 字）仍走 HARD_EXCLUDE REJECT。
        if (el.tagName === 'BUTTON') {
          const _bt = (el.textContent || '').trim();
          if (_bt.length >= _buttonThreshold(_bt)) {
            if (stats) stats.longTextButton = (stats.longTextButton || 0) + 1;
            return NodeFilter.FILTER_SKIP;
          }
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (SK.HARD_EXCLUDE_TAGS.has(el.tagName)) {
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.tagName === 'PRE') {
          // (a) 經典 markdown 渲染：<pre><code>... → skip
          if (el.querySelector('code')) {
            if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
            return NodeFilter.FILTER_REJECT;
          }
          // (b) 語法高亮 <pre>：GitHub PrettyLights / hljs / prism / shiki 等用 <span>
          //     做 token，結構是「<pre>{text + <span>}*</pre>」，沒有 <code> 包裹。
          //     直接 element 子是 ≥2 個 <span> 且無 <a>/<em>/<strong> 等自然語言
          //     inline → 視為 code。
          //
          //     issue #50 fix：要求 ≥2 個 span。原規則「至少一個 span」會誤殺單一
          //     span 包整段純文字的場景（asuswrt-merlin.net changelog 用
          //     `<pre><span style="font-size:12px;">純文字</span></pre>` 控字級），
          //     真語法高亮一定是每個 token 包 span，單 span 是純樣式 wrapper。
          //
          //     不誤殺 Medium 留言用 <pre> 引用文字（那種通常含 <a> / <em>）。
          let spanCount = 0;
          let hasProseInline = false;
          for (const child of el.children) {
            if (child.tagName === 'SPAN') spanCount++;
            else if (PROSE_INLINE_TAGS.has(child.tagName)) hasProseInline = true;
          }
          if (spanCount >= 2 && !hasProseInline) {
            if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
            return NodeFilter.FILTER_REJECT;
          }
        }
        if (el.hasAttribute('data-shinkansen-translated')) {
          if (stats) stats.alreadyTranslated = (stats.alreadyTranslated || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // TD/TH 純識別符 cell skip：檔案列表 filename 欄、版號、hash 等。
        if ((el.tagName === 'TD' || el.tagName === 'TH') && isPureIdentifierCell(el)) {
          if (stats) stats.pureIdentifierCell = (stats.pureIdentifierCell || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // 日期 / 時間戳 cell skip:LLM 對短日期串易 hallucinate 出無關長文。
        if (isDateLikeText(el)) {
          if (stats) stats.dateLikeCell = (stats.dateLikeCell || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // font-size: 0 sr-only 技法：父元素 font-size:0 把文字「壓扁」，只給 screen
        // reader 讀。GitHub 檔案列表的 THEAD 欄位標題用此技法 + height: 8px 撐出
        // 一條極薄的視覺分隔線。FILTER_SKIP 不收為 unit、但允許 walker 進子節點
        //(防誤殺「父 font-size:0 消 inline-block whitespace gap、子各自設字級」的
        // 合法用法)。
        {
          const _cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
          if (_cs && _cs.fontSize === '0px') {
            if (stats) stats.fontSizeZero = (stats.fontSizeZero || 0) + 1;
            return NodeFilter.FILTER_SKIP;
          }
        }
        // v1.1.9: 統一使用 BLOCK_TAGS_SET.has() 取代舊版 BLOCK_TAGS.includes()
        if (!SK.BLOCK_TAGS_SET.has(el.tagName)) {
          if (stats) stats.notBlockTag = (stats.notBlockTag || 0) + 1;
          // v1.4.7 / v1.4.9: 非 block-tag 容器（DIV、SECTION 等）的補抓邏輯。
          // 典型案例：XenForo <div class="bbWrapper">
          //   Case A: "intro"<br>"Pros:"<ul><li>...</li></ul>"Overall..."
          //   Case B: "段落一"<br><br>"段落二"
          // DIV 不在 BLOCK_TAGS_SET → 以前直接 FILTER_SKIP，text node 完全不可見。
          // SK.isVisible gate(2026-07-08)：容器級 Case A-F 原本不查可見性(葉節點補抓
          // 路徑都有查，不對稱漏檢),display:none 的 template / 未展開 modal / prerender
          // 內容照收照翻純燒 token。block 路徑的 isVisible REJECT 只擋得住 block 元素
          // 自身隱藏，擋不住非 block 隱藏容器直接成 unit。
          if (!fragmentExtracted.has(el) && SK.isVisible(el) && !isInsideExcludedContainer(el, excludedMemo)) {
            let hasDirectText = false;
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim().length >= 2) {
                hasDirectText = true;
                break;
              }
            }
            if (hasDirectText && SK.containsBlockDescendant(el)) {
              // Case A (v1.4.7)：有 block 子孫 → 抽 inline fragment
              const frags = extractInlineFragments(el);
              if (frags.length > 0) {
                fragmentExtracted.add(el);
                // v1.10.45:Case A 容器同時是「其他 block 單元的祖先」。fragment 注入路徑
                // (injectFragmentTranslation)會對整個容器 el 做 snapshotOnce(存 el.innerHTML),
                // 但該 snapshot 是注入時才 lazy 取——容器內的 block 子單元(P/LI…)在更早批次
                // 已翻譯注入,導致容器的「原文」snapshot 被污染成含譯文。RESTORE 時
                // `el.innerHTML = 污染snapshot` 會把已還原的子段落整批沖回譯文,使用者按取消
                // 看到原文回不來(telefoncek.si .wrapper「Kategorije:」尾段 fragment + 內含
                // 37 個 ARTICLE P 的真實 case)。
                // 修法:趁全頁尚未翻譯,在收集當下就 snapshot 容器原文,確保 originalHTML[el]
                // 是真原文。snapshotOnce 具冪等性,注入時的呼叫變 no-op。
                // 結構通則(§8):描述「fragment 容器是其他 block 單元祖先」這個 DOM 巢狀特徵,
                // 不綁站點 / class。
                SK.snapshotOnce?.(el);
                for (const f of frags) {
                  results.push(f);
                  seen.add(f.startNode);
                  let _n = f.startNode;
                  while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
                  if (stats) stats.fragmentUnit = (stats.fragmentUnit || 0) + 1;
                }
              }
            } else if (
              // Case B (v1.4.9)：純文字 + BR、無 block 子孫 → 整體當 element 單元
              // 4 個條件全成立才匹配，避免誤抓 inline element / leaf-content-div / nav 短連結
              // / 麵包屑（每條對應一個既有 spec：detect-leaf-content-div /
              // detect-nav-anchor-threshold / detect-nav-content）
              SK.CONTAINER_TAGS.has(el.tagName) &&
              !seen.has(el) &&
              hasBrChild(el) &&
              directTextLength(el) >= 20 &&
              isCandidateText(el)
            ) {
              // v1.10.53: 超長區塊先嘗試按 <br><br> 段落邊界切成多個 fragment(平行批次 +
              // 避免單一 2 萬字 streaming segment「無法結束」)。切不出 ≥2 段(無段落邊界 /
              // 過濾後不足)才退回原本「整塊當單一 element 單元」行為。
              let splitFrags = null;
              if ((el.textContent || '').trim().length > SK.BR_BLOCK_SPLIT_CHARS) {
                const fr = splitBrBlock(el);
                if (fr.length >= 2) splitFrags = fr;
              }
              if (splitFrags) {
                fragmentExtracted.add(el);
                // 趁全頁未翻譯先 snapshot 容器原文,確保 RESTORE 拿到乾淨原文(同 Case A v1.10.45)
                SK.snapshotOnce?.(el);
                for (const f of splitFrags) {
                  results.push(f);
                  seen.add(f.startNode);
                  let _n = f.startNode;
                  while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
                  if (stats) stats.containerWithBrSplit = (stats.containerWithBrSplit || 0) + 1;
                }
              } else {
                results.push({ kind: 'element', el });
                seen.add(el);
                // 巢狀雙收守門(2026-07-09)：整顆收成 element unit 後，後代 <b> / SPAN
                // 若不標 fragmentExtracted,INLINE_PROSE / Case D/E 的 hasAncestorExtracted
                // 查不到祖先已被收，同段文字會再收一次(兩次序列化字串不同繞過 dedup →
                // 同段送 API 兩次、dual mode 雙譯文)。Case B 無 block 子孫，整顆 unit
                // 涵蓋全部後代，標記安全。
                fragmentExtracted.add(el);
                if (stats) stats.containerWithBr = (stats.containerWithBr || 0) + 1;
              }
            } else if (
              // Case C (v1.4.19)：container 有直接文字 + inline 元素（如 <a>），
              // 無 block 子孫、無 BR → 抽 inline fragment
              // 典型案例：XenForo bbWrapper "<p>text</p>" 以外的純行內段落：
              //   "There is actually <a>some evidence</a> to support..."
              // Case A 因 !containsBlock 失敗，Case B 因 !hasBR 失敗 → 整段被跳過。
              // directTextLength >= 20 確保非 nav 短連結（nav 的文字在 <a> 內，直接文字長度趨近 0）
              // 外語頁放寬至 2 字——短 label + inline 元素的 mixed-content（Amazon「ポイント: 11pt (1%)」等）
              SK.CONTAINER_TAGS.has(el.tagName) &&
              !seen.has(el) &&
              hasDirectText &&
              directTextLength(el) >= (_foreignPage ? 2 : 20) &&
              isCandidateText(el)
            ) {
              const frags = extractInlineFragments(el);
              if (frags.length > 0) {
                fragmentExtracted.add(el);
                for (const f of frags) {
                  results.push(f);
                  seen.add(f.startNode);
                  let _n = f.startNode;
                  while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
                  if (stats) stats.inlineMixedFragment = (stats.inlineMixedFragment || 0) + 1;
                }
              }
            } else if (
              // Case D:inline-style 容器（SPAN）直接含 text + 至少一個非 BR element 子。
              // 典型案例：YouTube yt-attributed-string 的 ytAttributedStringHost span，直接子混合
              //   "7:00" <span><a>...</a></span> "now we can see..." <span><img></span>
              // Case A 因 !containsBlockDescendant 失敗；Case B 因 !hasBrChild 失敗；
              // Case C 因 SPAN 不在 CONTAINER_TAGS 失敗 → 過去整段都被 SKIP。
              // 結構特徵（描述 DOM 不綁站點/class):tag 是 SPAN、有直接 text node、有直接非 BR
              // element 子、文字長度 >= 20、無 block 子孫、isCandidateText 通過。
              // hasAncestorExtracted 防 SPAN > SPAN 巢狀重複抽（BLOCK 補抓的 Case A/B/C 用
              // CONTAINER_TAGS 限定 DIV/SECTION 等不嵌套 tag 沒踩到 dedup;Case D 必須補上)。
              el.tagName === 'SPAN' &&
              !seen.has(el) &&
              !hasAncestorExtracted(el, fragmentExtracted) &&
              hasDirectText &&
              hasDirectNonBrElement(el) &&
              // v1.9.31: 原本只看 directTextLength >= 20,但 IG / Threads / Mastodon 等
              // 留言常見「<span><a>@mention</a>短直接文字</span>」結構,直接文字 < 20 字
              // 但加上 @mention anchor 的 textContent 後總長 >= 20 字明顯是 prose。
              // 改成「直接文字 >= 5 字 AND 整段 textContent >= 20 字」— 第一條防 SPAN
              // 純包 anchor 沒 prose 的場景(會被 leaf-anchor 補抓正確處理),第二條維持
              // 20 字 prose 標準。負向對照 short-inline-nav <span>Home <a>·</a> About</span>
              // 總 12 字 < 20 仍擋。
              // CJK-dominant 文本門檻減半:20 字 prose 門檻是拉丁字計價,CJK 資訊
              // 密度高、13 字已是完整句(實例:新聞頁 meta row 的
              // 「<span><span>作者：</span>13 字 author 行</span>」被 20 字門檻擋掉,
              // 整排只有它沒轉換)。刻意不套 _foreignPage 泛放寬——英文頁 nav 短連結
              // (負向對照 short-inline-nav「Home · About」12 字)必須維持被擋。
              (() => {
                const _total = (el.textContent || '').trim();
                const _cjk = (_total.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g) || []).length;
                const _cjkDominant = _cjk >= 5 && _cjk * 2 >= _total.length;
                const _t = _cjkDominant ? 10 : 20;
                return directTextLength(el) >= _t ||
                  (directTextLength(el) >= (_cjkDominant ? 2 : 5) && _total.length >= _t);
              })() &&
              isCandidateText(el)
            ) {
              const frags = extractInlineFragments(el);
              if (frags.length > 0) {
                fragmentExtracted.add(el);
                for (const f of frags) {
                  results.push(f);
                  seen.add(f.startNode);
                  let _n = f.startNode;
                  while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
                  if (stats) stats.inlineMixedSpan = (stats.inlineMixedSpan || 0) + 1;
                }
              }
            } else if (
              // Case E (v1.9.14):inline-style 容器 SPAN 直接含 text + BR(無非 BR element 子)。
              // 典型案例:Goodreads ReviewText 用 <span class="Formatted">句 1<br>句 2<br>句 3</span>
              // 包多段評論文字;部落格 / 留言區也常見「<span>text<br>text<br>...</span>」結構。
              // Case A 因 !containsBlockDescendant 失敗;Case B 因 SPAN 不在 CONTAINER_TAGS 失敗;
              // Case C 因 SPAN 不在 CONTAINER_TAGS 失敗;Case D 因 !hasDirectNonBrElement 失敗;
              // leaf-content-span 補抓 (span:not(:has(*))) 因 SPAN 有 BR 子失敗 → 過去整段被 SKIP。
              // 結構特徵:tag 是 SPAN、有直接 text、有 BR child、無非 BR element 子、無 block
              // 子孫、文字長度 >= 20、isCandidateText 通過。整段當 element 單元(Case B 風格,
              // 而非 fragment),讓 BR 透過既有 sentinel 流程序列化,LLM 看到 \n 分段對應翻譯。
              // hasAncestorExtracted 防巢狀 SPAN 重複抽(同 Case D)。
              // 與 Case D 互斥:Case D 要 hasDirectNonBrElement、本案明確 !hasDirectNonBrElement。
              el.tagName === 'SPAN' &&
              !seen.has(el) &&
              !hasAncestorExtracted(el, fragmentExtracted) &&
              hasDirectText &&
              hasBrChild(el) &&
              !hasDirectNonBrElement(el) &&
              // v1.9.31: 與 Case D 對稱放寬,讓 BR 分段的短直接文字 SPAN(含 mention
              // 或 inline link 後展開的 br 多段)在總長 >= 20 字時通過。
              (() => {
                const _t = _foreignPage ? 2 : 20;
                return directTextLength(el) >= _t ||
                  (directTextLength(el) >= 2 && (el.textContent || '').trim().length >= _t);
              })() &&
              isCandidateText(el)
            ) {
              results.push({ kind: 'element', el });
              seen.add(el);
              fragmentExtracted.add(el);
              if (stats) stats.spanWithBr = (stats.spanWithBr || 0) + 1;
            } else if (
              // Case F (v1.10.1):block-displayed container(DIV / SECTION 等 CONTAINER_TAGS
              // 或 computed display:block)含 ≥ 3 inline-style 直接子 + ≥ 1 wrapper element
              // (自身含 element child)結構。
              //
              // 典型場景:X / Twitter 主推文,結構為
              //   <div data-testid="tweetText" dir="auto" lang="zh">
              //     <span>第一句</span><div style="display:inline-flex"><a>@mention</a></div>
              //     <span><span>段1</span><span class="r-b88u0q">段2</span><span>段3</span>…</span>
              //   </div>
              // wrapper 元素可能是 SPAN(含 hashtag / inner prose SPAN)或
              // DIV(inline-flex,X 的 @mention 渲染用 DIV 包 SPAN>A)。
              //
              // tweetText DIV(non-BLOCK_TAGS_SET,走 non-block 分支)既有 Case A-E 全部
              // miss(無 hasDirectText、無 hasBrChild、SPAN 不在 CONTAINER_TAGS),
              // FILTER_SKIP 後 leaf-content-span 補抓:SPAN[2] 內 r-b88u0q 短文 SPAN
              // (< 20 字)會被 20 字 short guard 擋,翻不到。整顆 tweetText 也可能因
              // outer block 影響被當 unit 走 framework-managed nodeValue mutate path,
              // A3 對齊 segment fallback catch-all 把整段譯文塞 ss[0]、其餘設 "" → 主推文
              // 95% 內文留簡中(2026-05-22 X 真實 case probe 確認)。
              //
              // 修法:這種結構顯然是 multi-segment prose 容器,直接 push 所有 descendant
              // leaf SPAN(no element child + text >= 2 字)各成 element unit。每個 leaf
              // 是單 text-node,後續 mutate path Case 2(textNodes.length === 1)對齊穩定。
              // 同時 add el to fragmentExtracted 避免 walker 後續對 descendant 重覆抓 fragment。
              //
              // 結構通則(§8):描述 DOM 特徵「block-displayed 容器 + 子全 inline-style +
              // 含 wrapper element(有 element child)」,不綁 tag name / 站點。
              //
              // 守門:el 自身 display 是 block / flex / grid / list-item(避免 inline-style
              // wrapper 自己誤觸發,Case D/E 已處理 inline 情境)+ 直接子 ≥ 3 +
              // 子全 inline + wrapperChildCount >= 1。reply 單 SPAN 結構(直接子=1)不觸發,
              // 維持既有 mutate path。Wikipedia P 含 A/EM/STRONG 但無 wrapper element
              // (wrapperChildCount=0)不觸發(A/EM/STRONG 是 leaf inline,children.length=0
              // 因為只含 text node)。
              !seen.has(el) &&
              !fragmentExtracted.has(el) &&
              (() => {
                const win = el.ownerDocument?.defaultView;
                const selfCs = win?.getComputedStyle?.(el);
                const selfDsp = selfCs?.display;
                if (selfDsp !== 'block' && selfDsp !== 'flex' && selfDsp !== 'grid'
                    && selfDsp !== 'list-item') return false;
                const directChildren = Array.from(el.children);
                if (directChildren.length < 3) return false;
                let wrapperChildCount = 0;
                for (const c of directChildren) {
                  const dcs = win?.getComputedStyle?.(c);
                  const dsp = dcs?.display;
                  if (dsp !== 'inline' && dsp !== 'inline-block' && dsp !== 'inline-flex') {
                    return false;
                  }
                  // 排除語意 inline(A / STRONG / EM 等):這些自然含子元素
                  // (如 <a><span>text</span></a>)但不是結構 wrapper
                  if (c.children.length > 0 && !SK.PRESERVE_INLINE_TAGS.has(c.tagName)) wrapperChildCount++;
                }
                return wrapperChildCount >= 1;
              })()
            ) {
              if (stats) stats.multiSegmentInlineBlock = (stats.multiSegmentInlineBlock || 0) + 1;
              widgetRejectedBlocks.add(el);
              fragmentExtracted.add(el);
              const leaves = el.querySelectorAll('span:not(:has(*))');
              for (const leaf of leaves) {
                if (seen.has(leaf)) continue;
                if (leaf.hasAttribute('data-shinkansen-translated')) continue;
                const text = (leaf.textContent || '').trim();
                if (text.length < 2) continue;
                if (!SK.isVisible(leaf)) continue;
                if (!isCandidateText(leaf)) continue;
                results.push({ kind: 'element', el: leaf });
                seen.add(leaf);
              }
              // Case F 容器內「wrapper SPAN 直接含裸 text node」的 prose 補抓:
              // leaf 掃描(span:not(:has(*)))看不到 wrapper 內的裸 text node——
              // 典型結構:新聞頁 meta row 的
              //   <span><span>作者：</span>国际电子商情综合报道</span>
              // 正文在 text node、旁邊有短 label 元素子,既非 leaf 也進不了
              // Case D(本容器已 add fragmentExtracted,hasAncestorExtracted 擋住)。
              // 對「有直接文字的 wrapper SPAN」走 Case D 同款 fragment 抽取。
              // X tweetText 原始場景 wrapper 無直接文字(全在 leaf SPAN 內)→
              // directTextLength 0 不觸發,行為不變。
              for (const s of el.querySelectorAll('span')) {
                if (seen.has(s) || fragmentExtracted.has(s)) continue;
                // 巢狀 wrapper dedup:s 與容器之間若有祖先已被抽過(querySelectorAll
                // 文件序外層先處理),內層跳過防重複
                let _anc = s.parentElement, _ancExtracted = false;
                while (_anc && _anc !== el) {
                  if (fragmentExtracted.has(_anc)) { _ancExtracted = true; break; }
                  _anc = _anc.parentElement;
                }
                if (_ancExtracted) continue;
                if (s.children.length === 0) continue;           // leaf 已由上方掃描處理
                if (directTextLength(s) < 2) continue;           // 純 wrapper(X tweetText 場景)不觸發
                if (!SK.isVisible(s)) continue;
                if (!isCandidateText(s)) continue;
                const frags = extractInlineFragments(s);
                if (frags.length === 0) continue;
                fragmentExtracted.add(s);
                for (const f of frags) {
                  results.push(f);
                  seen.add(f.startNode);
                  let _n = f.startNode;
                  while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
                  if (stats) stats.multiSegmentWrapperFragment = (stats.multiSegmentWrapperFragment || 0) + 1;
                }
              }
              // Case F 容器內的 <a>:若 A 內含已偵測 leaf SPAN 則加 seen(防重複收),
              // 否則不加——讓 leaf-content-anchor 路徑獨立偵測(A 本身有文字但沒
              // 被 Case F leaf SPAN 覆蓋的場景,如 Amazon format-strip A 只含 I icon)。
              for (const a of el.querySelectorAll('a')) {
                const _hasDetectedLeaf = [...a.querySelectorAll('span:not(:has(*))')].some(s => seen.has(s));
                if (_hasDetectedLeaf) seen.add(a);
              }
            }
          }
          return NodeFilter.FILTER_SKIP;
        }
        if (isInsideExcludedContainer(el, excludedMemo)) {
          if (stats) stats.excludedContainer = (stats.excludedContainer || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!SK.WIDGET_CHECK_EXEMPT_TAGS.has(el.tagName) && isInteractiveWidgetContainer(el)) {
          if (stats) stats.interactiveWidget = (stats.interactiveWidget || 0) + 1;
          // v1.9.31: 記住此 block,後續 leaf 補抓的 hasBlockAncestor 視為非 block 祖先。
          // FILTER_SKIP(非 FILTER_REJECT):本 block 自己不當 unit(避免整顆送 LLM 壓扁
          // 版面,保留 v0.39 widget rejection 原意),但讓 walker 下去找內部 Case A-E
          // 能對到的 mixed-inline SPAN / 長文 P / heading 等真實 prose unit。
          // 真實 case:IG modal「查看回覆」展開的 reply SPAN 結構為
          //   <span dir="auto"><a>@mention</a>werden sie auch nie machen...</span>
          // SPAN 有 anchor 子(非 leaf,leaf 補抓接不到),只有 walker Case D 能抽 fragment。
          // 原 FILTER_REJECT 不下去 → reply 永遠翻不到。
          if (SK.BLOCK_TAGS_SET.has(el.tagName)) widgetRejectedBlocks.add(el);
          return NodeFilter.FILTER_SKIP;
        }
        if (!SK.isVisible(el)) {
          if (stats) stats.invisible = (stats.invisible || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // v1.4.17: Block element 有 CONTAINER_TAGS 直屬子容器，且容器內有直屬 <A> 連結時，
        // 改為只捕捉 <A> 連結本身（而非整個 block）。
        // 原因：若把整個 block（如 TD）當一個翻譯單元，injectIntoTarget 走 clean-slate 路徑
        // 會清空 TD 的全部子元素，包含不需翻譯的相鄰容器（如 TD > DIV.smallfont > SPAN.author）。
        // 典型案例：vBulletin forumdisplay：
        //   td > div → a[thread_title] + div.smallfont → span(author)
        // Gemini 翻完 thread title 後 slot 1（作者名）被丟掉 → clean-slate 把整個 TD 清空
        // → 作者 ID 消失。改為只翻 A 連結，TD 結構完全保留。
        //
        // v1.8.33: 順序提到 mediaCardSkip 之前。原本兩條規則同時滿足時 mediaCardSkip
        // 先命中（line 順序),v1.4.17 永遠跑不到。真實案例：vBulletin 訂閱中 thread:
        //   td > div > [span(prefix), a#thread_gotonew(textLen=0，含 img 圖示),
        //                a#thread_title(font-weight:bold)]
        //   + div.smallfont > span(author)
        // TD 同時：含 img(thread_gotonew 的 16px 跳到第一筆未讀圖示) + 直屬子有 DIV
        // → mediaCardSkip 條件成立 → 整個 TD SKIP,A#thread_title 沒被任何葉節點補抓
        // 邏輯接走（A 是 inline 直接含 text,Case A-D 都不抓)。提前後 v1.4.17 先抓 A
        // → SKIP + skipBlockWithContainer/blockContainerLink 計數；沒 A 可抓時 fallthrough
        // 到原 mediaCardSkip 路徑，既有附件 LI 行為不變。
        if (!fragmentExtracted.has(el)) {
          const containerKids = Array.from(el.children).filter(c =>
            SK.CONTAINER_TAGS.has(c.tagName));
          if (containerKids.length > 0) {
            let capturedLinks = 0;
            for (const container of containerKids) {
              for (const child of Array.from(container.children)) {
                if (child.tagName !== 'A') continue;
                if (seen.has(child)) continue;
                if (child.hasAttribute('data-shinkansen-translated')) continue;
                if (!SK.isVisible(child)) continue;
                if (!isCandidateText(child)) continue;
                results.push({ kind: 'element', el: child });
                seen.add(child);
                capturedLinks++;
                if (stats) stats.blockContainerLink = (stats.blockContainerLink || 0) + 1;
              }
            }
            if (capturedLinks > 0) {
              fragmentExtracted.add(el);
              if (SK.BLOCK_TAGS_SET.has(el.tagName)) structurallySkippedBlocks.add(el);
              if (stats) stats.skipBlockWithContainer = (stats.skipBlockWithContainer || 0) + 1;
              return NodeFilter.FILTER_SKIP;
            }
          }
        }
        // v1.4.20: block element 同時有功能性媒體（img/picture/video）＋CONTAINER_TAGS 直屬子容器
        // = 媒體卡片模式（附件清單、圖片庫 item）。
        // 若整體收進來翻，injectIntoTarget 走 clean-slate 會清空所有子元素（含 img），
        // 圖片直接消失。改為 FILTER_SKIP，讓 walker 往裡找真正可翻的葉節點。
        // 典型案例：XenForo 附件 LI：li > [a.file-preview > img, div.file-content]
        // 注意：刻意用 img/picture/video 而非 containsMedia（後者含 svg/canvas/audio），
        // 避免誤傷含 SVG icon 的標題（如 Substack h2.header-anchor-post 內有 SVG + div.anchor）。
        //
        // v1.5.7: 排除 H1–H6。HTML5 語意上 heading 永遠是「標題」，不會是 grid item /
        // 附件清單卡片。WordPress 主題（如 nippper.com）會把 hero 圖塞進 <h1> 內：
        //   <h1><img class="wp-post-image"><div><span>標題文字</span></div></h1>
        // 這結構直屬子節點是 [IMG, DIV]，不加 heading exclusion 會被 mediaCardSkip 誤殺，
        // 整個 H1 跳過、標題完全不翻。判定條件用 tag name 規範（語意層）而非站點 class，
        // 屬於結構性通則（CLAUDE.md 硬規則 §8）。
        //
        // v1.9.15: 排除「P/block element 直屬有實質文字(>= 20 chars)」case。
        // 真實案例:eet-china 文章 P 結構為「P > text + B*5 + text + DIV.partner-content」
        // 其中 partner-content 是內嵌廣告卡片(內含 img + nested DIV)。原條件 1+2+3 全命中,
        // 整段 P 被 mediaCardSkip 誤殺,只有廣告卡片內的 anchor / leaf 被葉節點補抓 →
        // P 的純文字段(2 個 text node 合計 200+ chars)永遠不翻。
        // 修法判斷:el 直屬文字長度 >= 20 = 文字才是 el 主體,CONTAINER 子是內嵌附屬區塊,
        // 整段送翻(走 element 路徑 / fragment 路徑)。
        // 既有 case 不破壞:LI > A.file-preview + DIV.file-content 結構 LI 直屬無文字
        // (file-preview / file-content 都是 element child),directTextLength=0 仍命中。
        if (
          !/^H[1-6]$/.test(el.tagName) &&
          el.querySelector('img, picture, video') &&
          (Array.from(el.children).some(c => SK.CONTAINER_TAGS.has(c.tagName))
           || !!el.querySelector(SK.CONTAINER_TAG_SELECTOR)) &&
          directTextLength(el) < 20
        ) {
          if (stats) stats.mediaCardSkip = (stats.mediaCardSkip || 0) + 1;
          // v2.0.79: 卡片本體不當 unit(保住 img),但 el 的「直屬 inline 文字」得有人接——
          // walker 往內只會抓到子容器裡的段落,直屬 text node 沒有任何補抓路徑會撿走
          //(leaf 補抓要求元素本身是葉節點,Case A-E 要求非媒體卡片結構)。
          // 真實案例:ifanr 首頁 header nav 的
          //   <li>媒体品牌<img arrow><div panel>…<div qrcode-box>…</div></div></li>
          // ——「媒体品牌」四字整條漏偵測(連免費簡繁轉換也吃不到,同列沒下拉面板的
          // 「知晓云」則正常轉成「知曉雲」,視覺上就是同一列有的轉有的沒轉)。
          // 抽成 fragment unit 後注入只動該 inline run,img / 子容器原地保留,
          // 與下方 containsBlockDescendant 分支同一處理模式(單一資料源)。
          if (!fragmentExtracted.has(el)) {
            const frags = extractInlineFragments(el, { containerBoundary: true, requireDirectText: true });
            if (frags.length > 0) {
              fragmentExtracted.add(el);
              for (const f of frags) {
                results.push(f);
                seen.add(f.startNode);
                let _n = f.startNode;
                while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
                if (stats) stats.fragmentUnit = (stats.fragmentUnit || 0) + 1;
                if (stats) stats.mediaCardDirectTextFragment = (stats.mediaCardDirectTextFragment || 0) + 1;
              }
            }
          }
          if (SK.BLOCK_TAGS_SET.has(el.tagName)) structurallySkippedBlocks.add(el);
          return NodeFilter.FILTER_SKIP;
        }
        if (SK.containsBlockDescendant(el)) {
          if (stats) stats.hasBlockDescendant = (stats.hasBlockDescendant || 0) + 1;
          if (!fragmentExtracted.has(el)) {
            const frags = extractInlineFragments(el);
            if (frags.length > 0) {
              fragmentExtracted.add(el);
              for (const f of frags) {
                results.push(f);
                seen.add(f.startNode);
                let _n = f.startNode;
                while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
                if (stats) stats.fragmentUnit = (stats.fragmentUnit || 0) + 1;
              }
            }
          }
          if (SK.BLOCK_TAGS_SET.has(el.tagName)) structurallySkippedBlocks.add(el);
          return NodeFilter.FILTER_SKIP;
        }
        // HARD_EXCLUDE 文字載體子樹膨脹 textContent（結構通則，v1.10.50 由 NOSCRIPT
        // 窄修通則化）：SCRIPT / STYLE / NOSCRIPT / TEXTAREA 的內部文字會被 textContent
        // 讀入，但 walker 對這些子樹一律 REJECT、serializer 也不會輸出它們——
        // 導致「isCandidateText 看 textContent 誤判通過、序列化後卻是空字串」的
        // 不一致：空段送 LLM 會誘發幻覺譯文（實測 <li><script>cookie JS</script></li>
        // 結構，flash 對空段自由發揮編出整段無關長文，並以 sha1('') cache key 跨頁汙染）。
        // 用 innerText 看真實可見文字；只在有這類子樹時才觸發（避免全路徑 reflow）。
        if (el.querySelector('script, style, noscript, textarea') &&
            (el.innerText || '').trim().length < 2) {
          if (stats) stats.hardExcludeInflated = (stats.hardExcludeInflated || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!isCandidateText(el)) {
          if (stats) stats.notCandidateText = (stats.notCandidateText || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // Block 元素有複雜內部結構（> 3 element 子孫）但極短可見文字（< 20 字）:
        // FILTER_SKIP 避免 clean-slate 注入破壞 flex/grid 排版。
        // 典型 case: Amazon 星星評分 histogram row（LI > SPAN > A[display:flex] >
        // {label DIV, progress bar DIV, percentage DIV}），注入譯文後 progress bar 消失。
        // H1-H6 不受限——短標題仍需翻譯。
        if (!/^H[1-6]$/.test(el.tagName) && el.querySelectorAll('*').length > 3) {
          const _visText = (el.innerText || '').trim();
          if (_visText.length < 20) {
            if (stats) stats.shortBlockComplexSkip = (stats.shortBlockComplexSkip || 0) + 1;
            if (SK.BLOCK_TAGS_SET.has(el.tagName)) shortBlockRejectedBlocks.add(el);
            return NodeFilter.FILTER_REJECT;
          }
        }
        if (stats) stats.acceptedByWalker = (stats.acceptedByWalker || 0) + 1;
        return NodeFilter.FILTER_ACCEPT;
      },
    };
    const walker = document.createTreeWalker(scopeRoot, NodeFilter.SHOW_ELEMENT, _walkerFilter);
    let node;
    // 批次 8 A7:includeRoot 時先手動對 scopeRoot 跑同一個 acceptNode(含 stats /
    // memo 副作用,與 walker 走到等價),ACCEPT 就先於 walker 迭代餵進同一條迴圈
    let _pendingRootNode = (_includeRootCandidate && scopeRoot.nodeType === Node.ELEMENT_NODE
      && _walkerFilter.acceptNode(scopeRoot) === NodeFilter.FILTER_ACCEPT) ? scopeRoot : null;
    while ((node = _pendingRootNode || walker.nextNode())) {
      _pendingRootNode = null;
      // v1.10.56: 被接受的 block 段落若超長且內部由 <br><br> 分段(可能再包一層 <font>/<span>
      // inline wrapper),切成多個 fragment——對齊 Case B(splitBrBlock)路徑,避免單一
      // ~2 萬字 unit 讓 thinking 模型 streaming『最後一段無法結束』。paulgraham.com/boss.html
      // 整篇塞在單一 <p><font>…<br><br>…</font></p> 是真實 case。結構通則(§8),不綁站點。
      if ((node.textContent || '').trim().length > SK.BR_BLOCK_SPLIT_CHARS) {
        const brTarget = findBrSplitTarget(node);
        if (brTarget) {
          const splitFrags = splitBrBlock(brTarget);
          if (splitFrags.length >= 2) {
            // 趁全頁未翻譯先 snapshot 容器原文,確保 RESTORE 拿到乾淨原文(同 Case A/B v1.10.45)
            SK.snapshotOnce?.(brTarget);
            for (const f of splitFrags) {
              results.push(f);
              seen.add(f.startNode);
              let _n = f.startNode;
              while (_n) { if (_n.nodeType === 1) seen.add(_n); if (_n === f.endNode) break; _n = _n.nextSibling; }
              if (stats) stats.blockBrSplit = (stats.blockBrSplit || 0) + 1;
            }
            // node 與內層 wrapper 都標記，避免 walker 後續訪問 wrapper 時 Case B 重複收集。
            // brTarget 一律進 fragmentExtracted(含 brTarget === node 的情形):split fragment
            // 已涵蓋其子樹的 inline run，不標的話 run 內巢狀 SPAN 會被 Case D/E 再收一次
            //(巢狀雙收守門，2026-07-09)。只標 brTarget 不標 node(兩者不同時):node 在
            // brTarget 之外可能還有未被 fragment 涵蓋的內容，不可整顆封鎖。
            seen.add(node);
            fragmentExtracted.add(brTarget);
            if (brTarget !== node) seen.add(brTarget);
            continue;
          }
        }
      }
      results.push({ kind: 'element', el: node });
      seen.add(node);
      // 巢狀雙收守門(2026-07-09):FILTER_ACCEPT 不阻擋 TreeWalker 走訪子節點，
      // 整顆收成 element unit 的 block(P/LI/H1-6…)其後代 SPAN 仍會進非-block 分支。
      // 不標 fragmentExtracted 的話，Case D/E 的 hasAncestorExtracted 查不到祖先已被收，
      // 同段文字會再抽一次 fragment(P>SPAN 變體，probe 實測重現)。被 accept 的 block
      // 必無 block 子孫(containsBlockDescendant 分支先擋)，整顆 unit 涵蓋全部後代，
      // 標記安全，hasAncestorExtracted 的 crossedBlock 豁免也不會誤觸發。
      fragmentExtracted.add(node);
    }

    // BUTTON 內部 leaf 補抓:acceptNode 以 FILTER_SKIP 放行的 BUTTON,
    // 子 SPAN 在 walker 非-block 路徑不被收。
    // 找 BUTTON 內最深的 leaf SPAN 當 unit,保留按鈕結構(icon / SVG 不受影響)。
    // 門檻:CJK >= 3 字 / non-CJK >= 8 字。
    scopeRoot.querySelectorAll('button').forEach(btn => {
      if (seen.has(btn)) return;
      const text = (btn.textContent || '').trim();
      if (text.length < _buttonThreshold(text)) return;
      if (btn.hasAttribute('data-shinkansen-translated')) return;
      if (!SK.isVisible(btn)) return;
      if (isInsideExcludedContainer(btn, excludedMemo)) return;
      // widget 祖先檢查:按鈕在 widget 容器內不偵測（Twitter Follow 等）
      // 外語頁放行——按鈕文字是使用者需要理解的 UI 元素
      if (!_foreignPage) {
        let _cur = btn.parentElement;
        while (_cur && _cur !== document.body) {
          if (widgetRejectedBlocks.has(_cur)) return;
          _cur = _cur.parentElement;
        }
      }
      if (!isCandidateText(btn)) return;
      // near-leaf:直接子全是 SPAN 的 SPAN（含純 leaf）。覆蓋「label + badge」結構
      // 如 Amazon review tag BUTTON > SPAN["コスパ" + child SPAN"（135）"]
      const leaves = btn.querySelectorAll('span:not(:has(> :not(span)))');
      let added = false;
      for (const leaf of leaves) {
        if (seen.has(leaf)) continue;
        const lt = (leaf.textContent || '').trim();
        if (lt.length < 2) continue;
        if (!SK.isVisible(leaf)) continue;
        results.push({ kind: 'element', el: leaf });
        seen.add(leaf);
        leaf.querySelectorAll('span').forEach(s => seen.add(s));
        added = true;
        if (stats) stats.longTextButtonLeaf = (stats.longTextButtonLeaf || 0) + 1;
      }
      if (!added) {
        results.push({ kind: 'element', el: btn });
        seen.add(btn);
        if (stats) stats.longTextButtonDirect = (stats.longTextButtonDirect || 0) + 1;
      }
    });

    // shortBlockRejected 內部 leaf 補抓:shortBlockComplexSkip REJECT 的 block
    // 自己不當 unit（避免 clean-slate 破壞排版），但裡面有意義的 leaf 文字仍可翻
    //（Amazon 比較表格 "カートに入れる" / "購入オプション" / "報告する" 等）。
    // 門檻:CJK >= 4 字 / non-CJK >= 8 字（CJK 4 排除 histogram "星5つ" 3 字）。
    for (const block of shortBlockRejectedBlocks) {
      block.querySelectorAll('span:not(:has(*)), a:not(:has(*))').forEach(leaf => {
        if (seen.has(leaf)) return;
        const txt = (leaf.textContent || '').trim();
        const _sbThreshold = _CJK_RE.test(txt) ? 4 : 8;
        if (txt.length < _sbThreshold) return;
        if (!SK.isVisible(leaf)) return;
        if (!isCandidateText(leaf)) return;
        results.push({ kind: 'element', el: leaf });
        seen.add(leaf);
        if (stats) stats.shortBlockLeaf = (stats.shortBlockLeaf || 0) + 1;
      });
    }

    // 補抓 selector 指定的特殊元素
    // v1.9.13: scopeRoot.querySelectorAll(主 root 是 document.body,shadow 路徑是 ShadowRoot)
    scopeRoot.querySelectorAll(SK.INCLUDE_BY_SELECTOR).forEach(el => {
      if (seen.has(el)) return;
      if (el.hasAttribute('data-shinkansen-translated')) return;
      // v1.10.1: 已被 Case F(walker 非-block 分支)處理過的 multi-segment block 容器
      // 不再整顆當 unit — Case F 已把 descendant leaf SPAN 各拆成獨立 unit。
      // 對應 X 主推文 [data-testid="tweetText"] 場景:Case F 觸發後 tweetText DIV 不該
      // 再被 INCLUDE_BY_SELECTOR 補抓拉回成 outer unit(否則整顆送 LLM 又走 mutate
      // catch-all bug,既有 leaf unit 跟 outer unit 兩條 path drift)。
      if (fragmentExtracted.has(el)) return;
      if (isInsideExcludedContainer(el, excludedMemo)) return;
      if (isInteractiveWidgetContainer(el)) return;
      if (!SK.isVisible(el)) return;
      if (!isCandidateText(el)) return;

      // v1.10.1: INCLUDE_BY_SELECTOR scope 內「全 leaf SPAN 直接子」拆 leaf。
      //
      // 典型場景:X / Twitter quoted tweet,結構為
      //   <div data-testid="tweetText" lang="en">   ← display: flow-root
      //     <span>One fun thing about owning a home in San Francisco...</span>
      //     <span>https://default.sfplanning.org/...</span>
      //   </div>
      //
      // 不像主推文有 mention DIV + wrapper SPAN(走 walker Case F 拆 leaf),
      // quoted tweet 只有 2 個 leaf SPAN 各 1 text node,Case F 條件
      // (directChildren >= 3 + wrapperSpanCount >= 1) 都不符。
      //
      // Bug:整顆被 INCLUDE_BY_SELECTOR 抓進 results 當單一 element unit,
      // inject 階段 X 是 framework-managed → 走 v1.9.27 fallback。A1
      // tryInjectNodeValueMutate 對 2 個 visible text node 配對失敗
      // (source seq != target seq) → A2 fallback injectDual append sibling
      // SHINKANSEN-TRANSLATION wrapper。結果:原英文留在 tweetText 內 + 中文
      // wrapper 出現在 tweetText 的同層 sibling DIV(2026-05-22 真實 X
      // emissionite/status/2056826455032828131 probe 確認),違反 §15 single
      // mode 譯文必須注入回原 element。
      //
      // 修法:命中 INCLUDE_BY_SELECTOR 的 element 若結構是「block-displayed
      // (含 flow-root) + 直接子 >= 2 + 全 leaf SPAN with text >= 2 字」,
      // 拆 leaf 各成 element unit + mark fragmentExtracted。每個 leaf 是
      // single text node → A1 nodeValue mutate 成功 → single 視覺。
      //
      // 結構通則(§8):描述 DOM 特徵「全 leaf SPAN 直接子的 block 容器」,
      // 不綁站點。但條件限縮在 INCLUDE_BY_SELECTOR scope 內(site-curated
      // selector list),爆炸半徑只到該 list 收錄的少數容器,不影響一般網頁 P / DIV。
      //
      // 不放寬到 walker Case F 的理由:Case F 通則放寬會誤抓 typography
      // 框架 SPAN-wrapped 單詞高亮 / syntax highlight 等場景(這些通常不在
      // INCLUDE_BY_SELECTOR scope 內,所以方案 2 避開了)。
      //
      // 對主推文(已被 walker Case F 處理過)無影響:line 962 的
      // fragmentExtracted.has(el) early return 已先擋掉。
      if (!fragmentExtracted.has(el)) {
        const win = el.ownerDocument?.defaultView;
        const selfCs = win?.getComputedStyle?.(el);
        const selfDsp = selfCs?.display;
        const isBlockDisplay = selfDsp === 'block' || selfDsp === 'flow-root' ||
                               selfDsp === 'flex' || selfDsp === 'grid' ||
                               selfDsp === 'list-item';
        if (isBlockDisplay) {
          const directChildren = Array.from(el.children);
          const allLeafSpan = directChildren.length >= 2 && directChildren.every(c =>
            c.tagName === 'SPAN' &&
            c.children.length === 0 &&
            (c.textContent || '').trim().length >= 2
          );
          if (allLeafSpan) {
            if (stats) stats.includeSelectorLeafSplit = (stats.includeSelectorLeafSplit || 0) + 1;
            fragmentExtracted.add(el);
            widgetRejectedBlocks.add(el);
            for (const leaf of directChildren) {
              if (seen.has(leaf)) continue;
              if (leaf.hasAttribute('data-shinkansen-translated')) continue;
              if (!SK.isVisible(leaf)) continue;
              if (!isCandidateText(leaf)) continue;
              results.push({ kind: 'element', el: leaf });
              seen.add(leaf);
            }
            return;
          }
        }
      }

      if (stats) stats.includedBySelector = (stats.includedBySelector || 0) + 1;
      results.push({ kind: 'element', el });
      // v1.10.46: 全檔唯一漏 seen.add 的收集入口——少這行同 el 會再被後續補抓 pass
      // (leaf-content-div 等)雙收,下游 text-hash dedup 歸同 entry 後 broadcast 對
      // 同 el 注入兩次,第二次被 echo 判定誤判 → _revertEcho 沖回原文
      seen.add(el);
    });

    // v1.10.28: inline 格式化元素 prose 補抓。
    // <b>/<strong>/<i>/<em>/<u>/<font>/<mark>/<cite> 直接包整段 prose 文字(常以 <br>
    // 分段),掛在非-block 容器下,而其唯一 block 祖先已被結構性跳過。這類元素既非
    // CONTAINER_TAGS(Case B/C)也非 SPAN(Case D/E),walker 非-block 分支 Case A-F
    // 全 miss;leaf 補抓只收 div/span:not(:has(*)) 與 a → 完全漏抓。
    // 典型:vBulletin / phpBB / email-style HTML 主貼文 ──
    //   <div class="post_message"><b>主文段1<br><br>主文段2…</b><div class="bbcodestyle">引用…</div></div>
    // 引用區塊(block table)走正常 walker 路徑被收,但 <b> 主文整段不翻
    //(2026-06-08 forum.miata.net 真實 case:單頁 25 篇中 5 篇命中此結構)。
    //
    // 守門(每條都是「該由別條既有 path 處理」的排除,不是站點特判):
    //   - hasBlockAncestor:在「已被收集的 block prose」內(<p>…<b>強調</b>…</p>)→ 該
    //     block unit 已涵蓋,不重複收。structurallySkipped / widgetRejected 的 block 不算
    //     祖先(見 hasBlockAncestor),正好讓「孤兒 <b>」(block 祖先 TD 因 containsBlockDescendant
    //     被跳)能被撈出 — 這就是 miata case 能命中、一般 <p> 內 <b> 不誤命中的關鍵。
    //   - hasAncestorExtracted:父容器/inline 已抽 fragment(Case C/D/E)→ skip。
    //   - containsBlockDescendant:含 block 子孫 → 由 walker / fragment 路徑處理。
    //   - directTextLength >= 20(外語頁 >= 2):排除 <b>OK</b> 這類短強調。
    // push element unit(非 fragment),讓 <br> 走既有 sentinel 序列化、譯文注入回原 <b>(§15)。
    // 標記後代 seen,避免下方 leaf-content-anchor / leaf-content-div 重複收 <b> 內的 a/span。
    scopeRoot.querySelectorAll(INLINE_PROSE_WRAPPER_SELECTOR).forEach(el => {
      if (seen.has(el)) return;
      if (el.hasAttribute('data-shinkansen-translated')) return;
      if (hasBlockAncestor(el)) return;
      if (hasAncestorExtracted(el, fragmentExtracted)) return;
      if (SK.containsBlockDescendant(el)) return;
      if (isInsideExcludedContainer(el, excludedMemo)) return;
      if (isInteractiveWidgetContainer(el)) return;
      if (!SK.isVisible(el)) return;
      if (!isCandidateText(el)) return;
      if (directTextLength(el) < (_foreignPage ? 2 : 20)) return;
      results.push({ kind: 'element', el });
      seen.add(el);
      fragmentExtracted.add(el);
      el.querySelectorAll('*').forEach(c => seen.add(c));
      if (stats) stats.inlineProseWrapper = (stats.inlineProseWrapper || 0) + 1;
    });

    // v0.42: leaf content anchor 補抓
    scopeRoot.querySelectorAll('a').forEach(a => {
      // querySelectorAll('a') 也匹配 SVG <a>(SVGAElement)。SVG 元素沒有 innerText,
      // 收進 unit 後 translateUnits 序列化直接 TypeError 讓整頁翻譯失敗；非 HTML
      // 元素本就不該走 HTML 注入路徑，結構性排除。
      if (!(a instanceof HTMLElement)) return;
      if (seen.has(a)) return;
      if (a.hasAttribute('data-shinkansen-translated')) return;
      if (hasBlockAncestor(a)) return;
      if (SK.containsBlockDescendant(a)) return;
      if (a.querySelector(SK.CONTAINER_TAG_SELECTOR)) {
        // 外語頁短文字 anchor 允許含 CONTAINER child（icon + text 的 <a><div>text</div></a> 結構）
        if (!_foreignPage) return;
        const _ct = (a.textContent || '').trim();
        if (_ct.length >= 20 || _ct.length < 2) return;
      }
      if (isInsideExcludedContainer(a, excludedMemo)) return;
      if (isInteractiveWidgetContainer(a)) return;
      if (!SK.isVisible(a)) return;
      if (!isCandidateText(a)) return;
      // v1.6.9: textContent 取代 innerText（避免 layout reflow）
      const txt = (a.textContent || '').trim();
      if (txt.length < 20) {
        if (!_foreignPage || txt.length < 2) return;
        let _inWidget = false;
        { let _cur = a.parentElement;
          while (_cur && _cur !== document.body) {
            if (widgetRejectedBlocks.has(_cur)) { _inWidget = true; break; }
            _cur = _cur.parentElement;
          }
        }
        if (_inWidget) {
          if (!_foreignPage) return;
          // 外語頁:自身是 widget trigger（role="button" + 非真實 href）仍 skip
          const _aRole = a.getAttribute('role');
          const _aHref = a.getAttribute('href');
          if (_aRole === 'button' && (!_aHref || _aHref === '#' || _aHref.startsWith('javascript:'))) return;
          // widget 已被 Case F 拆為 leaf SPAN 的（fragmentExtracted），mention anchor 不重複收
          { let _cur2 = a.parentElement;
            while (_cur2 && _cur2 !== document.body) {
              if (widgetRejectedBlocks.has(_cur2) && fragmentExtracted.has(_cur2)) return;
              _cur2 = _cur2.parentElement;
            }
          }
        }
      }
      if (stats) stats.leafContentAnchor = (stats.leafContentAnchor || 0) + 1;
      results.push({ kind: 'element', el: a });
      seen.add(a);
    });

    // v1.0.8: leaf content element 補抓（CSS-in-JS 框架）
    // v1.6.9: 收緊 selector 為 :not(:has(*))——只抓「無 element 子節點」的 div/span,
    // 把過濾從 JS forEach 路徑下放到原生 CSS engine。長頁（Wikipedia / 論壇）原本
    // querySelectorAll('div, span') 可能回傳幾萬個 element，新版只回傳數百個葉節點，
    // 後續 isVisible / textContent / isCandidateText 等檢查減少 95% 以上呼叫次數。
    // :has() 支援：Chrome 105+ / Firefox 121+ / Safari 15.4+，皆已是 stable 多年。
    scopeRoot.querySelectorAll('div:not(:has(*)), span:not(:has(*))').forEach(d => {
      if (seen.has(d)) return;
      // v1.10.46: 容器已被 walker fragment 抽取(文字 run 已各自成 unit)→ 不得再整顆
      // 收成 element unit。fragment 只標 fragmentExtracted 不進 seen(容器可能還有其他
      // run),這裡漏查會產生「同 el fragment+element 雙 unit」→ 同 text dedup 歸同
      // entry → broadcast 雙注入 → 第二次被 echo 判定沖回原文
      if (fragmentExtracted.has(d)) return;
      if (d.hasAttribute('data-shinkansen-translated')) return;
      // d.children.length > 0 過濾已由 :not(:has(*)) selector 取代，移除
      if (hasBlockAncestor(d)) return;
      if (isInsideExcludedContainer(d, excludedMemo)) return;
      if (isInteractiveWidgetContainer(d)) return;
      if (!SK.isVisible(d)) return;
      if (!isCandidateText(d)) return;
      // v1.6.9: textContent 取代 innerText
      const txt = (d.textContent || '').trim();
      if (txt.length < 2) return;
      // v1.8.61: 短文字 leaf DIV/SPAN(2-19 字)必須是 visual prominent block
      // heading(display 為 block 系列 + font-size >= 24px)才放行。對應上報網站
      // 「編輯部推薦」(5 字 / 48px / block / sel-tit2 class)這類 DIV section
      // title — 非 H1-H6 但視覺是大字標題,沒這條補抓會永久不翻。24px 是 heading
      // 慣例下限(body 14-18px / prominent heading >= 24px),跟 timestamp / author
      // / inline counter 等 14-20px 噪音明確分開;display 限 block 系列(排除
      // inline span 短字如 author / time / counter)。結構性通則(visual
      // prominence),不靠 class 黑白名單(對應硬規則 §6 / §8)。
      if (txt.length < 20) {
        if (_foreignPage && txt.length >= 2) {
          // 外語頁:widget 容器內的 leaf 依容器大小決定——小型 widget（profile card /
          // Follow button 等可見文字 < 50 字）仍 skip；大型 widget（review block 等
          // 含實質內容）放行
          let _cur = d.parentElement;
          while (_cur && _cur !== document.body) {
            if (widgetRejectedBlocks.has(_cur)) {
              if ((_cur.innerText || '').trim().length < 50) return;
              break;
            }
            _cur = _cur.parentElement;
          }
        } else {
          const cs = getComputedStyle(d);
          const fs = parseFloat(cs.fontSize) || 0;
          const disp = cs.display;
          const isBlockDisplay = disp === 'block' || disp === 'flex' ||
                                 disp === 'grid' || disp === 'list-item';
          if (!(isBlockDisplay && fs >= 24)) return;
        }
      }
      if (stats) stats.leafContentDiv = (stats.leafContentDiv || 0) + 1;
      results.push({ kind: 'element', el: d });
      seen.add(d);
    });

    // v1.0.22: grid cell leaf text 補抓
    scopeRoot.querySelectorAll('table[role="grid"] td').forEach(td => {
      // v1.6.9: textContent 取代 innerText
      const tdText = (td.textContent || '').trim();
      if (tdText.length < 20) return;
      if (td.hasAttribute('data-shinkansen-translated')) return;

      td.querySelectorAll('*').forEach(el => {
        if (seen.has(el)) return;
        if (el.hasAttribute('data-shinkansen-translated')) return;

        for (const child of el.children) {
          if ((child.textContent || '').trim().length >= 15) return;
        }

        const text = (el.textContent || '').trim();
        if (text.length < 15) return;

        if (!SK.isVisible(el)) return;
        if (!isCandidateText(el)) return;

        if (stats) stats.gridCellLeaf = (stats.gridCellLeaf || 0) + 1;
        results.push({ kind: 'element', el });
        seen.add(el);
      });
    });
    }  // end processScope

    // 主 scope:document.body(或 caller 指定的 root)
    processScope(root, includeRoot);

    // v1.9.13: open Shadow DOM descent。對 root subtree 內所有 open shadow root 各跑
    // 一次 processScope。host 端 ancestor exclude(footer / role=contentinfo 等)在
    // shadow boundary 自然斷掉(parentElement 走到 shadowRoot 時為 null)— 這對 web
    // component 的隔離語意是預期行為,shadow content 自身結構若含 EXCLUDE_ROLES 仍會被擋。
    if (typeof SK.findOpenShadowRoots === 'function') {
      const shadowRoots = SK.findOpenShadowRoots(root);
      for (const sr of shadowRoots) {
        if (stats) stats.shadowRootsScanned = (stats.shadowRootsScanned || 0) + 1;
        processScope(sr);
      }
    }

    return results;
  };

  // dual mode 前置:把共用同一 block ancestor 的 inline-display element unit 合併成
  // 一個 element unit(用 block ancestor 當 el)。讓 LLM 拿到完整上下文翻譯,dual
  // inject 只產一個 wrapper。single mode 不需要(framework-managed nodeValue mutate
  // 路徑逐 SPAN 改 text node,視覺無碎片)。
  SK.consolidateDualInlineUnits = function consolidateDualInlineUnits(units) {
    if (!units || units.length === 0) return units;
    const win = document.defaultView;
    if (!win) return units;

    // block ancestor → [index in units]
    const groups = new Map();
    const unitBlockAnc = new Array(units.length);
    const unitElSet = new Set();
    for (let i = 0; i < units.length; i++) {
      if (units[i].el) unitElSet.add(units[i].el);
    }

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.kind !== 'element' || !u.el || !u.el.isConnected) continue;
      const cs = win.getComputedStyle(u.el);
      const dsp = cs?.display || '';
      if (!dsp.startsWith('inline')) continue;
      const anc = SK.findBlockAncestor?.(u.el);
      if (!anc || anc === document.body) continue;
      // block ancestor 已經是另一個 unit → 交給 inject dedup,不合併
      if (unitElSet.has(anc)) continue;
      unitBlockAnc[i] = anc;
      if (!groups.has(anc)) groups.set(anc, []);
      groups.get(anc).push(i);
    }

    // 只合併有 >= 2 個 inline unit 的 group
    const toRemove = new Set();
    // v1.10.39(code review 2026-06-09 L4):改用 Map<insertAt, unit>,避免下方 loop
    // 對每個被移除 unit 都 O(replacements) 線性 .find(大頁面 dual mode O(removed×groups))
    const replacementByIndex = new Map(); // insertAt → 合併後的 ancestor unit
    for (const [anc, indices] of groups) {
      if (indices.length < 2) continue;
      for (const idx of indices) toRemove.add(idx);
      replacementByIndex.set(indices[0], { kind: 'element', el: anc });
    }
    if (toRemove.size === 0) return units;

    const result = [];
    for (let i = 0; i < units.length; i++) {
      if (toRemove.has(i)) {
        const rep = replacementByIndex.get(i);
        if (rep) result.push(rep);
        continue;
      }
      result.push(units[i]);
    }
    SK.sendLog?.('info', 'detect', 'consolidateDualInlineUnits', {
      before: units.length, after: result.length, merged: toRemove.size,
    });
    return result;
  };

  // v1.9.13: 找出 root subtree 內所有 open shadow root,遞迴進去再找(shadow 內可能還有
  // shadow)。closed shadow root 受 web spec 安全限制,從 JS 完全不可達,只能跳過。
  SK.findOpenShadowRoots = function findOpenShadowRoots(root) {
    if (!root) return [];
    const found = [];
    function walk(node) {
      if (!node || node.nodeType !== 1) return;  // 只 traverse Element
      if (node.shadowRoot && node.shadowRoot.mode === 'open') {
        found.push(node.shadowRoot);
        let inner = node.shadowRoot.firstElementChild;
        while (inner) { walk(inner); inner = inner.nextElementSibling; }
      }
      let c = node.firstElementChild;
      while (c) { walk(c); c = c.nextElementSibling; }
    }
    if (root.nodeType === 1) {
      walk(root);
    } else if (root.firstElementChild) {
      // ShadowRoot / DocumentFragment 等:直接從 firstElementChild 開始
      let c = root.firstElementChild;
      while (c) { walk(c); c = c.nextElementSibling; }
    }
    return found;
  };

  // ─── 術語表輸入萃取 ──────────────────────────────────

  SK.extractGlossaryInput = function extractGlossaryInput(units) {
    const parts = [];
    const title = document.title?.trim();
    if (title) parts.push(title);

    for (const unit of units) {
      // v1.10.46: fragment unit 沒有 parent 欄位(shape 是 {kind,el,startNode,endNode}),
      // 一律取 unit.el — 之前讀 unit.parent 永遠 undefined,fragment 全被 continue 跳過
      const el = unit.el;
      if (!el) continue;
      const tag = el.tagName;

      if (/^H[1-6]$/.test(tag)) {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      if (tag === 'FIGCAPTION' || tag === 'CAPTION') {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      const fullText = el.innerText?.trim();
      if (!fullText) continue;
      const sentenceMatch = fullText.match(/^[^.!?。！？]*[.!?。！？]/);
      const firstSentence = sentenceMatch ? sentenceMatch[0] : fullText.slice(0, 200);
      if (firstSentence.length >= 10) {
        parts.push(firstSentence);
      }
    }

    return parts.join('\n');
  };

  // ─── v1.7.1+: 翻譯優先級排序（v1.7.2 加入 tier 0 細分) ──────────
  // 把「使用者最想看的內容」推到 array 前面，讓 batch 0 翻譯完成時視覺上是
  // 「文章開頭變中文」而不是「導覽列變中文」。本函式只重排 array 順序，
  // 不過濾任何單元——所有 unit 都還是會翻，只是時序不同。
  //
  // tier 0：祖先含 <main>/<article> + readability score >= 1(v1.8.40 起，原本 >=5)
  //         → 文章核心 + 中等內文段（article 內幾乎所有非極短雜訊段)
  // tier 1：祖先含 <main>/<article> + score < 1 → 極短雜訊（byline / metadata 一兩字)
  //         舊版邊界 5 把中等 P 段（score 1-5）推到這層，造成 H tag +5 boost 讓 H 段
  //         先翻、內文段後翻的「斷層」體感（詳見 prioritizeUnits 內 inline 註解)
  // tier 2：祖先無 main/article + 文字長度 ≥ 80 + 連結密度 < 0.5 → 一般內文段落
  // tier 3：其他 → 短連結 / nav / 補抓出來的零碎元素
  //
  // V8 的 Array.prototype.sort 自 2018 起為 stable sort(Chrome 70+),
  // 同 tier 內維持原 DOM 順序——TreeWalker 走過的次序保留，只是把高 tier 推前。
  // 注入用 element reference，不依賴 array index → 排序不影響注入位置。
  //
  // readability score 借用 Mozilla Readability 的評分啟發式，只取結構訊號（文字長度、
  // 逗號數、heading tag、含 P 子孫)，刻意不用 class/id 名稱啟發式——避免命中
  // 「ca-nstab-main」這類含 main 字眼但實際是 chrome 的元素（符合硬規則 §8 結構通則)。
  function readabilityScore(el) {
    if (!el) return 0;
    let score = 0;
    const text = el.textContent || '';
    score += text.length / 100;                                    // 文字長度
    score += (text.match(/[,,]/g) || []).length;                   // 逗號數（內文訊號，nav/tab 通常無逗號)
    if (/^H[1-3]$/.test(el.tagName)) score += 5;                   // 標題 tag 加分
    if (el.querySelector && el.querySelector('p')) score += 3;     // 含 <p> 子孫加分
    return score;
  }

  // v1.9.27 Layer 11(viewport prefetch):計算 element 距 viewport 的距離。
  // viewport 內 → 0(優先翻譯);viewport 外 → 元素中心點到 viewport 中心的絕對距離。
  // 用作 prioritizeUnits 同 tier 內的 secondary sort,讓使用者看到的段落最先翻好;
  // viewport 外的段落仍然會翻,只是排在後面 batch。
  function computeViewportDistance(unit) {
    const el = unit.el;
    if (!el || typeof el.getBoundingClientRect !== 'function') return Infinity;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (_) { return Infinity; }
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    if (rect.bottom >= 0 && rect.top <= vh) return 0;
    const elCenter = (rect.top + rect.bottom) / 2;
    const viewportCenter = vh / 2;
    return Math.abs(elCenter - viewportCenter);
  }

  SK.prioritizeUnits = function prioritizeUnits(units) {
    const tierCache = new Map();
    const viewportCache = new Map();

    function computeTier(unit) {
      // fragment 用 unit.el(parent block，符合 extractInlineFragments push 結構);
      // element 用 unit.el。兩者統一。
      const el = unit.el;
      if (!el || !el.parentElement) return 3;

      // 祖先檢查：HTML5 語意 tag 或 ARIA role
      let cur = el.parentElement;
      let inMainOrArticle = false;
      while (cur && cur !== document.body) {
        const tag = cur.tagName;
        if (tag === 'MAIN' || tag === 'ARTICLE') { inMainOrArticle = true; break; }
        const role = cur.getAttribute && cur.getAttribute('role');
        if (role === 'main' || role === 'article') { inMainOrArticle = true; break; }
        cur = cur.parentElement;
      }

      if (inMainOrArticle) {
        // tier 0/1 細分：用 readability score 切「真內文」vs「main 內的雜訊」
        // v1.7.2 起原邊界 score >= 5。但 v1.7.2 的 H tag +5 boost 讓所有 H1/H2/H3
        // 自動 tier 0，而中等長度內文 P 段（textLen 100-300、commas 0-2)score 常常落在
        // 1-5 之間 → 被推到 tier 1。實測 Medium 文章「In 1988, I was obsessed...」
        // (score 3.15）被排到 prioIdx 28(原本 DOM idx 5),H3 副標卻在 prioIdx 2,
        // 使用者體感「heading 先出現，內文後補」斷層大。
        // v1.8.40 起降邊界到 score >= 1:article 內幾乎所有非極短雜訊段都 tier 0,
        // stable sort 保持 DOM 順序；只把「Member-only story」之類短 byline(score < 1)
        // 過濾到 tier 1。
        return readabilityScore(el) >= 1 ? 0 : 1;
      }

      // 祖先沒 main/article：用文字長度 + 連結密度判斷
      const text = (el.textContent || '').trim();
      if (text.length < 80) return 3;
      let linkChars = 0;
      const anchors = el.querySelectorAll ? el.querySelectorAll('a') : [];
      for (const a of anchors) linkChars += (a.textContent || '').length;
      if (text.length > 0 && linkChars / text.length >= 0.5) return 3;
      return 2;
    }

    for (const u of units) {
      tierCache.set(u, computeTier(u));
      viewportCache.set(u, computeViewportDistance(u));
    }
    // 主排序 tier ASC,同 tier 內 secondary 距 viewport 距離 ASC。同距離 stable
    // 保 DOM 順序(JS Array.sort 對等價值穩定,V8 / Node 22+ 規範)。
    return units.slice().sort((a, b) => {
      const tierDiff = tierCache.get(a) - tierCache.get(b);
      if (tierDiff !== 0) return tierDiff;
      return viewportCache.get(a) - viewportCache.get(b);
    });
  };

})(window.__SK);
