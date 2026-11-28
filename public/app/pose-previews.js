/**
 * 姿势库可视化预览插画渲染器（Phase 4-A）
 *
 * 为 10 款单人试穿姿势与 6 款双人约会合影姿势提供直观的时尚剪影/构图示意图，
 * 零外部依赖、自动适配浅色极光玻璃与暗夜液态玻璃双主题。
 * 若未来某个姿势挂载了自定义参考图（previewUrl），调用方优先展示实图，否则回落本 SVG 预览。
 */
(function initPosePreviewRenderer() {
  const HER = 'var(--pose-her, #F26B9E)';
  const HER_FILL = 'var(--pose-her-fill, rgba(244, 106, 160, 0.22))';
  const HIM = 'var(--pose-him, #6B89E6)';
  const HIM_FILL = 'var(--pose-him-fill, rgba(107, 137, 230, 0.20))';
  const PROP = 'var(--pose-prop, rgba(130, 126, 148, 0.55))';
  const PROP_SOFT = 'var(--pose-prop-soft, rgba(130, 126, 148, 0.16))';
  const ACCENT = 'var(--pose-accent, #F59E0B)';

  const SOLO_SVG = {
    '': `
      <rect x="16" y="14" width="56" height="72" rx="10" fill="${PROP_SOFT}" stroke="${PROP}" stroke-width="1.4" stroke-dasharray="4 3"/>
      <circle cx="44" cy="40" r="11" fill="${HER_FILL}" stroke="${HER}" stroke-width="2"/>
      <path d="M39 40l3.5 3.5L50 36" fill="none" stroke="${HER}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M30 66c3-9 25-9 28 0" fill="${HER_FILL}" stroke="${HER}" stroke-width="2" stroke-linecap="round"/>
      <path d="M62 22l2-4 2 4 4 2-4 2-2 4-2-4-4-2z" fill="${ACCENT}"/>
    `,
    mirror_peace: `
      <!-- 镜框 -->
      <rect x="12" y="8" width="64" height="84" rx="10" fill="${PROP_SOFT}" stroke="${PROP}" stroke-width="1.5"/>
      <path d="M18 18l8-6M18 26l14-10" stroke="${PROP}" stroke-width="1.2" opacity="0.5" stroke-linecap="round"/>
      <!-- 头部（微歪头） -->
      <circle cx="44" cy="28" r="9.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <path d="M35 28c0-7 18-7 18 0c1 6 1 11-2 14" fill="none" stroke="${HER}" stroke-width="1.8" stroke-linecap="round"/>
      <!-- 身体/裙摆 -->
      <path d="M35 41h18l5 32H30z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
      <!-- 右手持手机对镜 -->
      <path d="M53 45l7 7-5 6" fill="none" stroke="${HER}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="48" y="51" width="9" height="14" rx="2" fill="#fff" stroke="${PROP}" stroke-width="1.8"/>
      <circle cx="52.5" cy="54.5" r="1.1" fill="${PROP}"/>
      <!-- 左手脸旁比耶 V -->
      <path d="M35 46l-9-6 2-11" fill="none" stroke="${HER}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M28 29l-3.5-8M28 29l3.2-8.2" fill="none" stroke="${HER}" stroke-width="2.2" stroke-linecap="round"/>
    `,
    look_back: `
      <!-- 侧背地面线 -->
      <line x1="16" y1="88" x2="72" y2="88" stroke="${PROP}" stroke-width="1.3" stroke-dasharray="3 3"/>
      <!-- 飘逸长发弧线 -->
      <path d="M36 22c-8 7-9 18-4 28" fill="none" stroke="${HER}" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
      <path d="M51 24c6 6 8 15 4 24" fill="none" stroke="${HER}" stroke-width="2" stroke-linecap="round"/>
      <!-- 回眸头部 -->
      <circle cx="44" cy="24" r="9" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <circle cx="47.5" cy="23.5" r="1.2" fill="${HER}"/>
      <path d="M46 27c1.6 1 3 .4 3.5-.5" fill="none" stroke="${HER}" stroke-width="1.5" stroke-linecap="round"/>
      <!-- 回转箭头提示 -->
      <path d="M58 18c5 2 6 7 2 10" fill="none" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M62 28l-3 1 1-3" fill="none" stroke="${ACCENT}" stroke-width="1.5" stroke-linecap="round"/>
      <!-- 侧身背影与裙摆 -->
      <path d="M36 37l15 1 5 26H31z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
      <!-- 双腿微步 -->
      <path d="M39 64l-2 23M48 64l3 23" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round"/>
    `,
    pocket_cool: `
      <!-- 地面线 -->
      <line x1="18" y1="90" x2="70" y2="90" stroke="${PROP}" stroke-width="1.3"/>
      <!-- 头部 -->
      <circle cx="44" cy="20" r="8.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <!-- 挺拔身躯 -->
      <path d="M35 33h18l3 29H32z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
      <!-- 左手潇洒插兜（弯肘入袋） -->
      <path d="M35 36l-9 12 8 6" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M34 52h5" stroke="${HER}" stroke-width="2" stroke-linecap="round"/>
      <!-- 右手自然下垂 -->
      <path d="M53 36l5 22" fill="none" stroke="${HER}" stroke-width="2.3" stroke-linecap="round"/>
      <!-- 长腿微开站姿 -->
      <path d="M39 62l-4 27M49 62l5 27" fill="none" stroke="${HER}" stroke-width="2.5" stroke-linecap="round"/>
    `,
    tuck_hair: `
      <!-- 柔和柔光圈 -->
      <circle cx="44" cy="44" r="32" fill="${PROP_SOFT}"/>
      <!-- 近景头部微倾 -->
      <circle cx="43" cy="36" r="13.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.3"/>
      <path d="M30 35c1-11 26-11 26 1 0 9-2 15-5 19" fill="none" stroke="${HER}" stroke-width="2" stroke-linecap="round"/>
      <!-- 微笑表情 -->
      <path d="M39 40c2 2 6 2 8 0" fill="none" stroke="${HER}" stroke-width="1.7" stroke-linecap="round"/>
      <!-- 半身肩颈 -->
      <path d="M27 82c2-18 6-26 16-26s14 8 16 26" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2" stroke-linecap="round"/>
      <!-- 抬手轻撩耳边碎发 -->
      <path d="M56 68l9-18-8-14" fill="none" stroke="${HER}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M55 34c3-2 6-1 8 1" fill="none" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round"/>
    `,
    side_bag: `
      <!-- 侧身旋转底弧 -->
      <ellipse cx="44" cy="87" rx="22" ry="4" fill="none" stroke="${PROP}" stroke-width="1.2" stroke-dasharray="3 3"/>
      <!-- 侧身头部 -->
      <circle cx="42" cy="22" r="8.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <!-- 45度侧身轮廓 -->
      <path d="M36 34h12l4 30H33z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
      <!-- 清晰突出单肩腋下包 -->
      <path d="M46 35c7 4 11 11 10 20" fill="none" stroke="${ACCENT}" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="49" y="53" width="17" height="13" rx="3.5" fill="rgba(245, 158, 11, 0.28)" stroke="${ACCENT}" stroke-width="2.1"/>
      <line x1="52" y1="58" x2="63" y2="58" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round"/>
      <!-- 手搭肩带 -->
      <path d="M48 39l8 10-3 6" fill="none" stroke="${HER}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <!-- 双腿 -->
      <path d="M39 64l-1 22M46 64l2 22" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round"/>
    `,
    window_chin: `
      <!-- 窗户与日光斜线 -->
      <rect x="10" y="10" width="24" height="60" rx="3" fill="${PROP_SOFT}" stroke="${PROP}" stroke-width="1.4"/>
      <line x1="22" y1="10" x2="22" y2="70" stroke="${PROP}" stroke-width="1.1"/>
      <line x1="10" y1="40" x2="34" y2="40" stroke="${PROP}" stroke-width="1.1"/>
      <path d="M34 18l18 14M34 32l14 11" stroke="${ACCENT}" stroke-width="1.2" opacity="0.55" stroke-linecap="round"/>
      <!-- 窗台 -->
      <line x1="8" y1="74" x2="80" y2="74" stroke="${PROP}" stroke-width="2.2" stroke-linecap="round"/>
      <!-- 偏头 -->
      <circle cx="53" cy="36" r="12" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.3"/>
      <path d="M49 39c2 1.8 5.5 1.8 7.5 0" fill="none" stroke="${HER}" stroke-width="1.6" stroke-linecap="round"/>
      <!-- 托腮手臂（手肘撑窗台，掌托下巴） -->
      <path d="M44 73l3-17 4-9" fill="none" stroke="${HER}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M58 51c6 4 10 12 11 22H42" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
    `,
    sitting_cafe: `
      <!-- 咖啡桌与冰拿铁 -->
      <line x1="10" y1="70" x2="78" y2="70" stroke="${PROP}" stroke-width="2.4" stroke-linecap="round"/>
      <rect x="61" y="54" width="11" height="15" rx="2.5" fill="rgba(245, 158, 11, 0.24)" stroke="${ACCENT}" stroke-width="1.8"/>
      <line x1="68" y1="54" x2="72" y2="46" stroke="${ACCENT}" stroke-width="1.8" stroke-linecap="round"/>
      <!-- 对面坐姿人物 -->
      <circle cx="40" cy="28" r="11" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.3"/>
      <path d="M36 31c2 2 6 2 8 0" fill="none" stroke="${HER}" stroke-width="1.6" stroke-linecap="round"/>
      <!-- 身体微前倾 -->
      <path d="M28 43h24l3 26H25z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
      <!-- 双肘撑桌面 -->
      <path d="M28 48l-7 14 10 7M52 48l5 14-8 7" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    `,
    full_stride: `
      <!-- 街道地平线 -->
      <line x1="12" y1="90" x2="76" y2="90" stroke="${PROP}" stroke-width="1.5"/>
      <!-- 动感风纹 -->
      <path d="M16 42h9M13 52h11" stroke="${PROP}" stroke-width="1.3" stroke-linecap="round" opacity="0.65"/>
      <!-- 头部 -->
      <circle cx="46" cy="20" r="8.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <!-- 躯干 -->
      <path d="M38 32h16l3 26H35z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
      <!-- 摆臂 -->
      <path d="M38 36l-10 15M54 36l11 12" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round"/>
      <!-- 明显迈步双腿 -->
      <path d="M41 58l-11 29M49 58l12 28" fill="none" stroke="${HER}" stroke-width="2.6" stroke-linecap="round"/>
      <!-- 鞋子轮廓 -->
      <path d="M27 88h7M59 87h8" stroke="${ACCENT}" stroke-width="2.8" stroke-linecap="round"/>
    `,
    lean_wall: `
      <!-- 左侧墙面与光影 -->
      <line x1="22" y1="10" x2="22" y2="90" stroke="${PROP}" stroke-width="2.8" stroke-linecap="round"/>
      <path d="M22 18h-8M22 36h-8M22 54h-8M22 72h-8" stroke="${PROP}" stroke-width="1.2" opacity="0.55"/>
      <line x1="22" y1="90" x2="74" y2="90" stroke="${PROP}" stroke-width="1.4"/>
      <!-- 头部靠墙微仰 -->
      <circle cx="35" cy="22" r="8.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <!-- 背靠墙微斜身体 -->
      <path d="M29 34l14 1 6 27H32z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1" stroke-linejoin="round"/>
      <!-- 手臂自然放松 -->
      <path d="M43 38l8 18" fill="none" stroke="${HER}" stroke-width="2.3" stroke-linecap="round"/>
      <!-- 一腿直立一腿轻屈前伸 -->
      <path d="M36 62l-2 27M44 62l12 13-3 14" fill="none" stroke="${HER}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    `,
    playful_wink: `
      <!-- 轻快背景装饰 -->
      <circle cx="44" cy="48" r="32" fill="${PROP_SOFT}"/>
      <path d="M68 22l2-4 2 4 4 2-4 2-2 4-2-4-4-2z" fill="${ACCENT}"/>
      <!-- 大头近景微歪 -->
      <circle cx="44" cy="40" r="16" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.4"/>
      <!-- 左眼睁开 + 右眼俏皮眨眼 -->
      <circle cx="38" cy="38" r="2.1" fill="${HER}"/>
      <path d="M47 38.5c1.8-2.2 4.2-2.2 6 0" fill="none" stroke="${HER}" stroke-width="2.1" stroke-linecap="round"/>
      <!-- 开心大笑嘴 -->
      <path d="M39 45c2.5 3.2 7.5 3.2 10 0" fill="none" stroke="${HER}" stroke-width="2" stroke-linecap="round"/>
      <!-- 肩部与轻碰衣领的手 -->
      <path d="M25 84c3-16 8-24 19-24s16 8 19 24" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M28 74l9-13 5 3" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    `,
  };

  const COUPLE_SVG = {
    '': `
      <rect x="14" y="14" width="72" height="72" rx="10" fill="${PROP_SOFT}" stroke="${PROP}" stroke-width="1.4" stroke-dasharray="4 3"/>
      <circle cx="40" cy="42" r="10" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2"/>
      <circle cx="60" cy="45" r="9.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2"/>
      <path d="M50 28c1.5-2.5 5-2 5 1 0 3-5 5.5-5 5.5s-5-2.5-5-5.5c0-3 3.5-3.5 5-1z" fill="${HER}"/>
      <path d="M28 70c2-10 22-10 24 0M49 70c2-9 20-9 22 0" fill="none" stroke="${PROP}" stroke-width="2" stroke-linecap="round"/>
    `,
    couple_cheek_peace: `
      <!-- 男生（左） -->
      <circle cx="38" cy="34" r="11" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.3"/>
      <path d="M26 76c2-18 5-26 14-26 6 0 10 4 12 12" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.2" stroke-linecap="round"/>
      <!-- 男生左手比耶 -->
      <path d="M26 57l-9-8 2-10" fill="none" stroke="${HIM}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M19 39l-3-7.5M19 39l3-7.5" fill="none" stroke="${HIM}" stroke-width="2.1" stroke-linecap="round"/>
      <!-- 女生（右，头微贴近） -->
      <circle cx="60" cy="38" r="10.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.3"/>
      <path d="M47 76c2-16 6-24 14-24s12 8 14 24" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2" stroke-linecap="round"/>
      <!-- 女生右手比耶 -->
      <path d="M74 59l9-8-2-10" fill="none" stroke="${HER}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M81 41l-3-7.5M81 41l3-7.5" fill="none" stroke="${HER}" stroke-width="2.1" stroke-linecap="round"/>
    `,
    couple_shoulder_lean: `
      <!-- 小爱心 -->
      <path d="M51 16c1.5-2.5 5-2 5 1 0 3-5 5.8-5 5.8s-5-2.8-5-5.8c0-3 3.5-3.5 5-1z" fill="${HER}"/>
      <!-- 男生直立（左） -->
      <circle cx="38" cy="31" r="11" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.3"/>
      <path d="M24 84c2-22 6-36 16-36 9 0 13 10 15 36" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.2" stroke-linecap="round"/>
      <!-- 女生头轻靠男方肩头（右） -->
      <circle cx="56" cy="41" r="10" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.3"/>
      <path d="M49 84c2-18 6-30 15-30 8 0 12 10 14 30" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2" stroke-linecap="round"/>
      <!-- 亲密微斜引导弧 -->
      <path d="M54 32c-4 1-6 4-6 7" fill="none" stroke="${HER}" stroke-width="1.6" stroke-dasharray="2 2"/>
    `,
    couple_dining_toast: `
      <!-- 餐桌与菜盘 -->
      <line x1="10" y1="74" x2="90" y2="74" stroke="${PROP}" stroke-width="2.4" stroke-linecap="round"/>
      <ellipse cx="50" cy="72" rx="14" ry="3.5" fill="${PROP_SOFT}" stroke="${PROP}" stroke-width="1.3"/>
      <!-- 男生（左） -->
      <circle cx="30" cy="32" r="10" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.2"/>
      <path d="M18 73c1-16 4-26 12-26s11 10 12 26" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.1"/>
      <!-- 女生（右） -->
      <circle cx="70" cy="34" r="9.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <path d="M58 73c1-15 4-24 12-24s11 9 12 24" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1"/>
      <!-- 举杯干杯 -->
      <path d="M39 54l7-9M61 55l-7-10" fill="none" stroke="${PROP}" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="42" y="34" width="6.5" height="10" rx="1.5" transform="rotate(14 45 39)" fill="rgba(245,158,11,0.3)" stroke="${ACCENT}" stroke-width="1.7"/>
      <rect x="51.5" y="34" width="6.5" height="10" rx="1.5" transform="rotate(-14 55 39)" fill="rgba(245,158,11,0.3)" stroke="${ACCENT}" stroke-width="1.7"/>
      <path d="M50 24v4M45 27l2 2M55 27l-2 2" stroke="${ACCENT}" stroke-width="1.7" stroke-linecap="round"/>
    `,
    couple_walk_back: `
      <!-- 街景路面 -->
      <line x1="12" y1="90" x2="88" y2="90" stroke="${PROP}" stroke-width="1.4"/>
      <!-- 男生全身（左） -->
      <circle cx="34" cy="21" r="8" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.2"/>
      <path d="M27 32h14l2 27H25z" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2"/>
      <path d="M30 59l-5 29M38 59l5 29" fill="none" stroke="${HIM}" stroke-width="2.4" stroke-linecap="round"/>
      <!-- 女生全身（右） -->
      <circle cx="66" cy="25" r="7.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <path d="M59 35h14l3 24H56z" fill="${HER_FILL}" stroke="${HER}" stroke-width="2"/>
      <path d="M62 59l-4 29M70 59l5 29" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round"/>
      <!-- 中间紧牵的双手 -->
      <path d="M41 37l9 15 9-14" fill="none" stroke="${HER}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="50" cy="52" r="3.4" fill="${ACCENT}"/>
    `,
    couple_selfie_close: `
      <!-- 自拍取景框四角 -->
      <path d="M14 22v-8h8M86 22v-8h-8M14 78v8h8M86 78v8h-8" fill="none" stroke="${PROP}" stroke-width="1.8" stroke-linecap="round"/>
      <!-- 贴近镜头大头双人 -->
      <circle cx="39" cy="46" r="14" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.3"/>
      <path d="M35 49c2 2 6 2 8 0" fill="none" stroke="${HIM}" stroke-width="1.7" stroke-linecap="round"/>
      <circle cx="61" cy="48" r="13.5" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.3"/>
      <path d="M57 51c2 2 6 2 8 0" fill="none" stroke="${HER}" stroke-width="1.7" stroke-linecap="round"/>
      <!-- 肩部 -->
      <path d="M22 82c2-11 7-18 16-18M78 82c-2-10-7-17-16-17" fill="none" stroke="${PROP}" stroke-width="2.2" stroke-linecap="round"/>
      <!-- 镜头小红点 -->
      <circle cx="77" cy="23" r="2.5" fill="${HER}"/>
    `,
    couple_sunset_side: `
      <!-- 金色夕阳 -->
      <path d="M34 50a16 16 0 0 1 32 0" fill="rgba(245, 158, 11, 0.25)" stroke="${ACCENT}" stroke-width="1.8"/>
      <line x1="10" y1="62" x2="90" y2="62" stroke="${PROP}" stroke-width="2.2" stroke-linecap="round"/>
      <line x1="10" y1="74" x2="90" y2="74" stroke="${PROP}" stroke-width="1.3" opacity="0.6"/>
      <line x1="22" y1="62" x2="22" y2="86" stroke="${PROP}" stroke-width="1.4" opacity="0.6"/>
      <line x1="78" y1="62" x2="78" y2="86" stroke="${PROP}" stroke-width="1.4" opacity="0.6"/>
      <!-- 男生靠栏杆（左） -->
      <circle cx="39" cy="34" r="9.5" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.2"/>
      <path d="M29 61c1-11 4-16 10-16s9 5 10 16" fill="${HIM_FILL}" stroke="${HIM}" stroke-width="2.1"/>
      <!-- 女生靠栏杆（右） -->
      <circle cx="60" cy="37" r="9" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.2"/>
      <path d="M51 61c1-10 4-14 9-14s8 4 9 14" fill="${HER_FILL}" stroke="${HER}" stroke-width="2.1"/>
    `,
  };

  const OUTFIT_SVG = {
    preset_jk_shirt: `
      <!-- 白色海军领 JK 衬衫 -->
      <path d="M26 24l12-6h24l12 6 12 14-10 10-8-7v41H32V41l-8 7-10-10z" fill="#FFFFFF" stroke="#94A3B8" stroke-width="2" stroke-linejoin="round"/>
      <!-- 藏青海军领片 + 白色双杠 -->
      <path d="M38 18l12 20 12-20 8 4-11 22H41L30 22z" fill="#1E3A5F" stroke="#172554" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M34 24l8 16h16l8-16" fill="none" stroke="#E2E8F0" stroke-width="1.4" stroke-linecap="round"/>
      <!-- 藏青领结 -->
      <path d="M50 38l-9 6 3 7 6-5 6 5 3-7z" fill="#1D4ED8" stroke="#1E3A5F" stroke-width="1.3" stroke-linejoin="round"/>
      <circle cx="50" cy="39" r="3" fill="#1E3A5F"/>
      <!-- 袖口海军边 -->
      <path d="M16 37l9 9M84 37l-9 9" stroke="#1E3A5F" stroke-width="2.4" stroke-linecap="round"/>
    `,
    preset_plaid_skirt: `
      <!-- 藏青格纹百褶短裙 -->
      <rect x="29" y="18" width="42" height="9" rx="2.5" fill="#1E293B" stroke="#0F172A" stroke-width="1.8"/>
      <path d="M29 27h42l12 52H17z" fill="#2A3B5C" stroke="#172554" stroke-width="2" stroke-linejoin="round"/>
      <!-- 百褶竖线 -->
      <path d="M36 27l-6 52M43 27l-2 52M50 27v52M57 27l2 52M64 27l6 52" stroke="#0F172A" stroke-width="1.5" opacity="0.75"/>
      <!-- 浅灰+暗红格纹横竖细线 -->
      <path d="M24 44h52M21 58h58M19 71h62" stroke="#94A3B8" stroke-width="1.2" opacity="0.65"/>
      <path d="M23 51h54M20 65h60" stroke="#F472B6" stroke-width="0.9" opacity="0.5"/>
    `,
    preset_cream_cardigan: `
      <!-- 奶白麻花针织开衫 -->
      <path d="M34 18h32l16 14-6 44-12-2 3-26-3 34H36l-3-34 3 26-12 2-6-44z" fill="#FBF5EB" stroke="#C8B69E" stroke-width="2" stroke-linejoin="round"/>
      <!-- V 领开襟门襟 -->
      <path d="M40 18l10 24 10-24" fill="none" stroke="#B69F83" stroke-width="2" stroke-linejoin="round"/>
      <line x1="50" y1="42" x2="50" y2="82" stroke="#C8B69E" stroke-width="1.8"/>
      <!-- 暖木纽扣 -->
      <circle cx="54" cy="48" r="2.2" fill="#9C6B43"/>
      <circle cx="54" cy="59" r="2.2" fill="#9C6B43"/>
      <circle cx="54" cy="70" r="2.2" fill="#9C6B43"/>
      <!-- 麻花纹理线 -->
      <path d="M41 44c-2 4 2 8 0 12s2 8 0 12M59 44c2 4-2 8 0 12s-2 8 0 12" fill="none" stroke="#D6C4AD" stroke-width="1.6" stroke-linecap="round"/>
    `,
    preset_camel_coat: `
      <!-- 焦糖驼色双排扣毛呢大衣 -->
      <path d="M34 14h32l16 13-5 45-10-1 2-25-2 40H33l-2-40 2 25-10 1-5-45z" fill="#C99A6B" stroke="#8C6239" stroke-width="2" stroke-linejoin="round"/>
      <!-- 挺括大翻领 -->
      <path d="M39 14l11 26 11-26" fill="#E6C9A8" stroke="#8C6239" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M39 14l-7 16 10 8 8 2M61 14l7 16-10 8-8 2" fill="#B88758" stroke="#8C6239" stroke-width="1.6" stroke-linejoin="round"/>
      <!-- 双排玳瑁扣 + 门襟线 -->
      <line x1="50" y1="40" x2="50" y2="86" stroke="#8C6239" stroke-width="1.4"/>
      <circle cx="44" cy="50" r="2.3" fill="#4A2E19"/><circle cx="56" cy="50" r="2.3" fill="#4A2E19"/>
      <circle cx="44" cy="63" r="2.3" fill="#4A2E19"/><circle cx="56" cy="63" r="2.3" fill="#4A2E19"/>
      <!-- 斜插袋 -->
      <path d="M36 68h7M57 68h7" stroke="#7A5230" stroke-width="1.8" stroke-linecap="round"/>
    `,
    preset_black_puffer: `
      <!-- 炭黑短款面包羽绒服 -->
      <rect x="38" y="15" width="24" height="10" rx="4" fill="#2A2D34" stroke="#111318" stroke-width="1.8"/>
      <path d="M34 24h32c9 3 16 11 18 22l-8 25-11-2 2-19-2 26H35l-2-26 2 19-11 2-8-25c2-11 9-19 18-22z" fill="#2D3038" stroke="#111318" stroke-width="2" stroke-linejoin="round"/>
      <!-- 面包蓬松横格充绒线 -->
      <path d="M35 37h30M34 50h32M34 63h32" stroke="#4B505E" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M21 44l10 2M79 44l-10 2M23 56l9 1M77 56l-9 1" stroke="#4B505E" stroke-width="1.6" stroke-linecap="round"/>
      <!-- 中央拉链 -->
      <line x1="50" y1="24" x2="50" y2="76" stroke="#9CA3AF" stroke-width="1.6" stroke-dasharray="2.5 2"/>
    `,
    preset_mist_hoodie: `
      <!-- 雾霾蓝慵懒连帽卫衣 -->
      <path d="M36 25c0-11 28-11 28 0l-6 7H42z" fill="#7D9CC0" stroke="#537296" stroke-width="1.8"/>
      <path d="M32 26h36l16 14-7 35-10-2 2-20-2 28H33l-2-28 2 20-10 2-7-35z" fill="#8AA7C7" stroke="#537296" stroke-width="2" stroke-linejoin="round"/>
      <!-- 连帽抽绳 -->
      <path d="M45 31v15M55 31v15" stroke="#EEF4FF" stroke-width="2" stroke-linecap="round"/>
      <!-- 袋鼠前兜 -->
      <path d="M38 59h24l4 15H34z" fill="#7997B8" stroke="#537296" stroke-width="1.6" stroke-linejoin="round"/>
      <!-- 下摆罗纹 -->
      <line x1="33" y1="76" x2="67" y2="76" stroke="#537296" stroke-width="1.5"/>
    `,
    preset_french_dress: `
      <!-- 奶杏色法式碎花茶歇裙 -->
      <!-- 泡泡短袖 -->
      <ellipse cx="29" cy="31" rx="9" ry="11" fill="#FCECD9" stroke="#C8A27A" stroke-width="1.8"/>
      <ellipse cx="71" cy="31" rx="9" ry="11" fill="#FCECD9" stroke="#C8A27A" stroke-width="1.8"/>
      <!-- 方领上身 + 收腰 A 字茶歇裙摆 -->
      <path d="M34 22h9c2 6 12 6 14 0h9l-4 22 14 42H24l14-42z" fill="#FBEBD8" stroke="#C8A27A" stroke-width="2" stroke-linejoin="round"/>
      <!-- 收腰丝带 -->
      <line x1="38" y1="44" x2="62" y2="44" stroke="#D99B72" stroke-width="2.2"/>
      <!-- 温柔碎花点缀 -->
      <circle cx="44" cy="54" r="2.2" fill="#F48FB1"/><circle cx="57" cy="57" r="2.2" fill="#F48FB1"/>
      <circle cx="38" cy="68" r="2.2" fill="#F59E0B" opacity="0.8"/><circle cx="51" cy="66" r="2.2" fill="#F48FB1"/>
      <circle cx="62" cy="73" r="2.2" fill="#F48FB1"/><circle cx="44" cy="77" r="2" fill="#86EFAC"/>
    `,
    preset_wide_jeans: `
      <!-- 复古浅蓝高腰直筒牛仔裤 -->
      <path d="M31 15h38l5 71H54l-4-44-4 44H26z" fill="#9EBCE0" stroke="#5B7DA6" stroke-width="2" stroke-linejoin="round"/>
      <!-- 高腰头与门襟 -->
      <line x1="31" y1="22" x2="69" y2="22" stroke="#5B7DA6" stroke-width="1.7"/>
      <circle cx="50" cy="18.5" r="2" fill="#D9A86C"/>
      <path d="M50 22v16c0 3-3 5-5 5" fill="none" stroke="#5B7DA6" stroke-width="1.6" stroke-linecap="round"/>
      <!-- 两侧弧形牛仔口袋 -->
      <path d="M31 32c5 0 9-4 10-10M69 32c-5 0-9-4-10-10" fill="none" stroke="#5B7DA6" stroke-width="1.5"/>
      <!-- 水洗亮面高光 -->
      <path d="M36 42l-2 32M64 42l2 32" stroke="#D4E5F7" stroke-width="2.4" stroke-linecap="round" opacity="0.7"/>
    `,
    preset_white_sneakers: `
      <!-- 奶油厚底小白鞋（侧视经典构图） -->
      <path d="M18 58c0-10 5-20 12-23l7 7c5 3 11 1 15-4l16 14c8 2 15 6 16 12v8H18z" fill="#FAF9F5" stroke="#9CA3AF" stroke-width="2" stroke-linejoin="round"/>
      <!-- 厚底鞋底 -->
      <rect x="17" y="67" width="67" height="11" rx="5" fill="#F1EFE7" stroke="#9CA3AF" stroke-width="2"/>
      <line x1="24" y1="72.5" x2="76" y2="72.5" stroke="#D1CFC5" stroke-width="1.4" stroke-linecap="round"/>
      <!-- 鞋带细节 -->
      <path d="M47 45l6 3M51 49l6 3M56 53l6 3" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round"/>
      <!-- 鞋尾小拼色 -->
      <path d="M22 44c3 0 6 3 6 7h-9" fill="#E5E1D8" stroke="#9CA3AF" stroke-width="1.3"/>
    `,
    preset_martin_boots: `
      <!-- 复古哑光黑马丁短靴 -->
      <path d="M26 20h26l2 26 22 10c5 2 8 6 8 11v8H24V24z" fill="#26272D" stroke="#0F1014" stroke-width="2" stroke-linejoin="round"/>
      <!-- 标志性黄色沿条缝线 + 厚齿底 -->
      <path d="M23 73h62v8c0 2-2 4-4 4H27c-2 0-4-2-4-4z" fill="#18191D" stroke="#0F1014" stroke-width="1.8"/>
      <line x1="25" y1="73" x2="83" y2="73" stroke="#EAB308" stroke-width="2" stroke-dasharray="3.5 2.5"/>
      <!-- 鞋带与靴筒提耳 -->
      <path d="M47 28h7M48 35h7M49 42h7M51 49h7" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round"/>
      <path d="M26 20v-7h6v7" fill="none" stroke="#EAB308" stroke-width="2" stroke-linejoin="round"/>
    `,
    preset_underarm_bag: `
      <!-- 复古黑色链条腋下包 -->
      <!-- 拱形肩带（半皮半金链） -->
      <path d="M24 50c0-25 12-34 26-34s26 9 26 34" fill="none" stroke="#D9A84E" stroke-width="2.6" stroke-dasharray="4 2.5" stroke-linecap="round"/>
      <path d="M35 19c5-3 25-3 30 0" fill="none" stroke="#222328" stroke-width="4" stroke-linecap="round"/>
      <!-- 挺括包身 -->
      <path d="M18 48h64l-4 32c-.6 3.5-3.5 6-7 6H29c-3.5 0-6.4-2.5-7-6z" fill="#222328" stroke="#0E0F12" stroke-width="2" stroke-linejoin="round"/>
      <!-- 翻盖弧线 + 淡金锁扣 -->
      <path d="M19 52c14 13 48 13 62 0" fill="none" stroke="#3F414A" stroke-width="1.8"/>
      <rect x="44" y="57" width="12" height="9" rx="2.5" fill="#E8C375" stroke="#B68B33" stroke-width="1.4"/>
      <circle cx="50" cy="61.5" r="1.6" fill="#222328"/>
    `,
    preset_plaid_scarf: `
      <!-- 燕麦色羊绒格纹围巾 -->
      <!-- 围脖环绕层 -->
      <rect x="24" y="18" width="52" height="22" rx="10" fill="#E5D7C5" stroke="#B0987C" stroke-width="2"/>
      <!-- 两条自然垂坠尾片 -->
      <path d="M30 37h20v41H30z" fill="#DFD0BC" stroke="#B0987C" stroke-width="1.9" stroke-linejoin="round"/>
      <path d="M52 37h19v33H52z" fill="#E9DDD0" stroke="#B0987C" stroke-width="1.9" stroke-linejoin="round"/>
      <!-- 暖棕格纹线 -->
      <path d="M30 50h20M30 64h20M52 48h19M52 60h19" stroke="#9C7A58" stroke-width="1.5" opacity="0.7"/>
      <path d="M38 19v59M45 37v41M60 19v51" stroke="#9C7A58" stroke-width="1.4" opacity="0.65"/>
      <!-- 底部流苏 -->
      <path d="M32 78v8M37 78v8M42 78v8M47 78v8M55 70v8M60 70v8M65 70v8M69 70v8" stroke="#B0987C" stroke-width="1.6" stroke-linecap="round"/>
    `,
  };

  const SLOT_FALLBACK_SVG = {
    top: OUTFIT_SVG.preset_mist_hoodie,
    outerwear: OUTFIT_SVG.preset_camel_coat,
    bottom_or_dress: OUTFIT_SVG.preset_french_dress,
    shoes: OUTFIT_SVG.preset_white_sneakers,
    bag: OUTFIT_SVG.preset_underarm_bag,
    accessory: OUTFIT_SVG.preset_plaid_scarf,
  };

  window.renderPosePreviewSvg = function renderPosePreviewSvg(poseId, kind = 'solo') {
    const isCouple = kind === 'couple';
    const map = isCouple ? COUPLE_SVG : SOLO_SVG;
    const body = map[poseId || ''] || map[''];
    const vb = isCouple ? '0 0 100 96' : '0 0 88 96';
    return `<svg class="pose-preview-svg" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
  };

  window.renderOutfitPresetSvg = function renderOutfitPresetSvg(presetId, slot = 'top') {
    const body = OUTFIT_SVG[presetId || ''] || SLOT_FALLBACK_SVG[slot] || OUTFIT_SVG.preset_french_dress;
    return `<svg class="preset-garment-svg" viewBox="0 0 100 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
  };
})();
