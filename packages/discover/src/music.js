/**
 * Music feeds, kept by hand.
 *
 * /music is the one category with no search to run. A webcomic at least looks
 * like a blog somebody wrote about drawing; music mostly does not appear in
 * search results at all, because the places that hold it either publish no RSS
 * or publish it at addresses nobody links to. So this is a list, and every URL
 * in it was fetched and checked to carry audio in its entries before it went in.
 *
 * Two kinds of feed are here, and they arrive by different routes:
 *
 * The Podcasting 2.0 ones declare `<podcast:medium>music</podcast:medium>`, and
 * the parser reads that on its own — an album published this way is filed
 * correctly whether or not it is on this list. They are listed anyway because
 * the crawler has to be told the feed exists before it can read anything off it.
 *
 * The rest declare nothing. A Funkwhale channel, a WFMU show and an Internet
 * Archive netlabel collection are, to a parser, feeds with mp3s attached, which
 * is exactly what a blog with a narrated post looks like. Those are music
 * because somebody checked, which is what `curated` means.
 */

/**
 * Albums and singles published with `podcast:medium=music`.
 *
 * Self-hosted, mostly by the artist. This is the value-for-value scene, which
 * is currently the only place on the web where an album is routinely published
 * as a feed rather than as a page with a player on it.
 */
const MUSIC_MEDIUM_ALBUMS = [
  'https://www.doerfelverse.com/feeds/music-from-the-doerfelverse.xml',
  'https://www.doerfelverse.com/feeds/them.xml',
  'https://www.doerfelverse.com/feeds/wrathodies.xml',
  'https://doerfelverse.com/feeds/come-back-to-me.xml',
  'https://ableandthewolf.com/static/media/feed.xml',
  'https://henrikflyman.com/wp-content/uploads/rssfeed/album_feeds/henrik_flyman/diamonds_in_the_rough.xml',
  'https://henrikflyman.com/wp-content/uploads/rssfeed/album_feeds/henrik_flyman/edge_of_dawn.xml',
  'https://music.thinkandactlocally.com/sovereign-ground/feed.xml',
  'https://music.thinkandactlocally.com/beef/feed.xml',
  'https://theohm.art/releases/the_ohm-oscillators_of_tranquility_base/mp3/the_ohm-oscillators_of_tranquility_base.rss',
  'https://theohm.art/releases/the_ohm-the_black_tent_club/mp3/the_ohm-the_black_tent_club.rss',
  'https://cypherpunk.today/static/The_Ohm-The_Merge/the_ohm-the_merge.rss',
  'https://cypherpunk.today/static/bitcoin-maxi-on-leverage/bitcoin-maxi-on-leverage.rss',
  'https://www.falsefinish.club/wp-content/uploads/2023/05/Home-Sweet-Home-The-Dream-of-Love-Survives-but-it-Disappoints-Constantly.xml',
  'https://feed.falsefinish.club/Temples/Temples%20-%20lades/lades.xml',
  'https://feed.falsefinish.club/Temples/Temples%20-%20B-Sides/b_-_sides.xml',
  'https://brashhabits.com/music/BrashHabits/FeelingTheLight/BrashHabits-FeelingtheLight-2026.xml',
  'https://brashhabits.com/music/SpaceBucks/VucksGiven/Vucks_Given.xml',
  'https://phafe.com/wp-content/uploads/rssfeed/music/matt_finlay/kulture_collection/Kulture_Collection.xml',
  'https://music.behindthesch3m3s.com/wp-content/uploads/Matt_B/The_Matty_B_Sides/Wild_Thumbprints/wild_thumbprints.xml',
  'https://mmmusic.show/msp/The_No_Agenda_Album/The_No_Agenda_Album.xml',
  'https://headstarts.uk/msp/longy/songs%20from%20the%20seaside/Songs_From_The_Seaside.xml',
  'https://headstarts.uk/msp/longy/Healing%20Hands/Healing_Hands.xml',
  'https://headstarts.uk/msp/theshorseheads/singles/Singles.xml',
  'https://headstarts.uk/msp/Nathan%20Abbott/hookah-band/Hookah.xml',
  'https://www.gilligan.band/podcast/so-alive/feed.xml',
  'https://www.gilligan.band/podcast/come-alive/feed.xml',
  'https://www.leuenbergmusic.com/podcast/hello-cant-hold-these-demos-down-for-you/feed.xml',
  'https://files.heycitizen.xyz/Songs/Albums/The-Heycitizen-Experience/the%20heycitizen%20experience.xml',
  'https://static.staticsave.com/mspfiles/deathdreams.xml',
  'https://static.staticsave.com/mspfiles/waytogo.xml',
  'https://rocknrollbreakheart.com/msp/2CrystalBalls/2crystalballs.xml',
  'https://www.thisisjdog.com/media/ring-that-bell.xml',
  'https://zine.bitpunk.fm/feeds/spectral-hiding.xml',
  'https://s3.us-east-1.amazonaws.com/rss.letemriot.com/vertical/vertical.xml',
  'https://julliandmn.github.io/crastinaterpro.github.io/singles-feed.xml',
  'https://brrreadfan.github.io/feed.xml',
  'https://salt.ser.yachts/sb/music/album/orthogninal/feed.xml',
  'https://taylor-sound.com/msp/Silverseed/Beam%20of%20Light/beam%20of%20light.xml',
  'https://www.fearworm.me/msp/Raw%20with%202%20As/raw%20with%202%20as.xml',
  'https://hogstory.net/uploads/fabnaeosm/fabnaeosmv1_feed.xml',
  'https://www.hogstory.net/uploads/everythingislitremixes/everything_is_lit_remixes_feed.xml',
  'https://feeds.oldoakstudio.de/ric-sattler/tanz-am-druidenstein/feed.xml',
  'https://pc2.basspistol.com/liessets/tursdag_med_alv.xml',
  'https://country-express-feed.nyc3.digitaloceanspaces.com/JECEmainfeed.xml',
  'https://push-feed.nyc3.digitaloceanspaces.com/Push%20-%2011-3-2023%2017.47.09.xml',
  'https://rhythmicboozefeed.nyc3.digitaloceanspaces.com/Podcasts/Rhythmic%20Booze%20Feed.xml',
  'https://echo-drift.nyc3.digitaloceanspaces.com/Sonic-Feed/Sonic%20Feed.xml',
  "https://lunaticfriend.s3.us-west-1.amazonaws.com/top5/bryan%20duncan%20top%205.xml",
  "https://jimmiebratcher.s3.us-west-1.amazonaws.com/I'm%20Hungry%20Album/im-hungry.xml",
  'https://cdn.kolomona.com/podcasts/lightning-thrashes/bands/damn-your-idols/cast-a-shadow/cast-a-shadow-rss.xml',
  'https://annipowellmusic.com/wp-content/MusicSideProject/Peach%20Clouds%20Master%20and%20Album%20Cover/peach%20clouds%20RSS%20FEED.xml',
];

/**
 * Albums on the hosts that publish them for you.
 *
 * Wavlake rate-limits hard under parallel fetching, so its entries are few and
 * the pipeline's own pacing is what keeps this polite.
 */
const HOSTED_ALBUMS = [
  'https://wavlake.com/feed/music/08fc1d26-133d-450d-a5d5-a26b9352bb36',
  'https://wavlake.com/feed/music/964f8569-7929-46b2-adbc-be245894dcbf',
  'https://wavlake.com/feed/music/385caf85-33f5-4677-85ab-26188e9f0c6f',
  'https://wavlake.com/feed/music/ab4e4754-30b0-45f7-95cb-4f4182ea1dae',
  'https://wavlake.com/feed/music/d1e33580-ef5e-4fcd-ae9f-5863dc763754',
  'https://wavlake.com/feed/music/deddc329-ff2f-44c6-bbce-7202f3d16b64',
  'https://wavlake.com/feed/music/209857bf-7f4e-4f92-b122-e36f7be04a93',
  'https://wavlake.com/feed/music/7c108df1-ff9c-4a6c-bdb4-2f3b2d7fd9f4',
  'https://wavlake.com/feed/music/b204f296-ddfc-469a-8725-2b184933529f',
  'https://www.wavlake.com/feed/767f5393-998c-4e7e-9d4d-451c9724f558',
  'https://www.wavlake.com/feed/e894a222-dc48-4596-8053-1f3a262a941c',
  'https://www.wavlake.com/feed/e43280cd-3b26-4f07-9b09-f84390b3b4ae',
  'https://feeds.fountain.fm/eQ4qN2rBf5vdFQiu40hN',
  'https://feeds.fountain.fm/0nqce18mNO2WOe4v5Vv9',
  'https://feeds.fountain.fm/Pw6d3L9h2Itp3KxLpF3a',
  'https://feeds.fountain.fm/w7jl8l9PMNhJaf7pImYJ',
  'https://feeds.fountain.fm/ZQhv2gUYIeU9B3JxiAPa',
  'https://feeds.rssblue.com/primitive-mold',
  'https://feeds.rssblue.com/book-of-vibe',
  'https://serve.podhome.fm/rss/16aaaf37-259e-474c-a29c-acdfed5f8f04',
  'https://podcast.danielaragay.net/@danimusic/feed.xml',
  'https://podcast.studioalight.com/@DENT/feed.xml',
  'https://pirate.mxtthxw.art/@comiccapers/feed.xml',
  'https://technosets.soliddark.com/@soliddark/feed.xml',
  'https://podcast.stefansegers.nl/@mixingpodcastamsterdam/feed.xml',
  'https://podcast.latorre.noho.st/@los_vivos/feed.xml',
  'https://honeypot.garystallman.com/@honeypot/feed.xml',
  'https://castopod.warroza.pl/@dzwieki_otoczenia/feed.xml',
  'https://podcasts.support-pcs.co.uk/@redbutton/feed.xml',
  'https://podcast.golomazov.com/@golomazov/feed.xml',
  'https://pod.foss.wales/@SacredSound/feed.xml',
];

/**
 * Artists posting tracks on Funkwhale.
 *
 * A Funkwhale channel is an artist's uploads as RSS. It declares no medium, so
 * without this list every one of them is a blog that happens to attach mp3s.
 */
const FUNKWHALE_CHANNELS = [
  'https://open.audio/api/v2/channels/luciftias/rss',
  'https://open.audio/api/v2/channels/tadonic_music_channel/rss',
  'https://open.audio/api/v2/channels/lostandlobied_music_channel/rss',
  'https://open.audio/api/v2/channels/dub_arnology/rss',
  'https://open.audio/api/v2/channels/parsek/rss',
  'https://open.audio/api/v2/channels/peallaidh1/rss',
  'https://open.audio/api/v2/channels/ojoelgato_music_channel/rss',
  'https://open.audio/api/v2/channels/rampoinajams/rss',
  'https://open.audio/api/v2/channels/emi_music_channel/rss',
  'https://open.audio/api/v2/channels/schroedingers_suicide/rss',
  'https://funkwhale.it/api/v2/channels/arturoserrano/rss',
  'https://funkwhale.it/api/v2/channels/DPDmancul_songs/rss',
  'https://funk.firobe.fr/api/v1/channels/ogamixes/rss',
  'https://audio.anartist.org/api/v2/channels/tk/rss',
  'https://audio.anartist.org/api/v2/channels/rafapoverello_sencillos/rss',
  'https://stereo.kenobit.it/api/v1/channels/marco_sirma/rss',
  'https://soundfabrics.nl/feed.xml',
  'https://listen.soundslike.pro/podcast.rss',
  'https://shop.basspistol.com/podcast.rss',
  'https://faircamp.axwax.eu/podcast.rss',
];

/**
 * Netlabels and free-music archives.
 *
 * The Internet Archive collection feeds are the netlabel scene's surviving
 * distribution: the directories that used to index netlabels are all dead, and
 * the labels themselves mostly published to archive.org rather than to their
 * own sites. Each collection feed is a label's releases, newest first.
 */
const NETLABELS = [
  'https://archive.org/services/collection-rss.php?collection=netlabels',
  'https://archive.org/services/collection-rss.php?collection=mahorka',
  'https://archive.org/services/collection-rss.php?collection=clinicalarchives',
  'https://archive.org/services/collection-rss.php?collection=kahvi',
  'https://archive.org/services/collection-rss.php?collection=blocsonic',
  'https://archive.org/services/collection-rss.php?collection=sutemos',
  'https://archive.org/services/collection-rss.php?collection=ektoplazm',
  'https://archive.org/services/collection-rss.php?collection=enough_records',
  'https://archive.org/services/collection-rss.php?collection=treetrunk',
  'https://archive.org/services/collection-rss.php?collection=petroglyph-music',
  'https://archive.org/services/collection-rss.php?collection=kikapu',
  'https://archive.org/services/collection-rss.php?collection=we-are-all-ghosts',
  'https://archive.org/services/collection-rss.php?collection=restingbell',
  'https://archive.org/services/collection-rss.php?collection=vulpiano-records',
  'https://archive.org/services/collection-rss.php?collection=stoneage-records',
  'https://archive.org/services/collection-rss.php?collection=sostanze-records',
  'https://archive.org/services/collection-rss.php?collection=dubophonic',
  'https://archive.org/services/collection-rss.php?collection=green-field-recordings',
  'https://archive.org/services/collection-rss.php?collection=audiotalaia',
  'https://archive.org/services/collection-rss.php?collection=dr-noisem-tapes-netlabel',
  'https://archive.org/services/collection-rss.php?collection=12rec',
  'https://archive.org/services/collection-rss.php?collection=audiotong',
  'https://archive.org/services/collection-rss.php?collection=GratefulDead',
  'https://archive.org/services/collection-rss.php?collection=78rpm',
  'https://archive.org/services/collection-rss.php?collection=etree',
  'https://blocsonic.com/bloccasts/feed/tha-bloc-report.rss',
  'https://blocsonic.com/bloccasts/feed/bloc-discovery-sessions.rss',
  'http://ccmixter.org/api/query?f=rss&limit=20&sort=date',
  'http://ccmixter.org/api/query?f=rss&tags=instrumental&limit=25',
];

/**
 * Mixes and music radio.
 *
 * A DJ mix is a playlist that happens to be one file, and a freeform music show
 * is a playlist somebody talks over occasionally. Several of these carry the
 * full podcast namespace because they are distributed through podcast hosting,
 * which is why they need saying explicitly: the parser would file them as shows.
 */
const MIXES_AND_RADIO = [
  'https://ra.co/xml/podcast.xml',
  'https://feeds.soundcloud.com/playlists/soundcloud:playlists:110848044/sounds.rss',
  'https://feeds.soundcloud.com/users/soundcloud:users:3656987/sounds.rss',
  'https://feeds.soundcloud.com/users/soundcloud:users:345852/sounds.rss',
  'https://feeds.soundcloud.com/users/soundcloud:users:52628851/sounds.rss',
  'https://feeds.soundcloud.com/users/soundcloud:users:128985219/sounds.rss',
  'https://www.omnycontent.com/d/playlist/bad5d079-8dcb-4630-8770-aa090049131d/18f3a48e-1c64-43e8-96e9-aa40002038ee/856f4314-821f-46ca-bc8e-aa40002038f2/podcast.rss',
  'https://feeds.simplecast.com/KlTkmdVl',
  'https://rss.buzzsprout.com/1139528.rss',
  'https://feeds.95bfm.com/bfmsolidsteel',
  'https://feeds.feedburner.com/alexfromtokyopodcasts',
  'https://musicforprogramming.net/rss.xml',
  'https://feeds.captivate.fm/technolivesets/',
  'https://djcarl.com/audio/mixshow.ritz.rss',
  'https://djcarl.com/audio/podcast.urban.rss',
  'https://www.dirtydiscoradio.com/feed/podcast/',
  'https://deepspacepodcast.com/feed/podcast/',
  'https://www.cybergrooveam.com/category/cgradio/feed/podcast/',
  'https://www.djmoose.ca/feed/djmoosestwit/',
  'https://www.jaynichol.co.uk/category/mixes/feed/',
  'https://www.namnamradio.com/feed/podcast/',
  'https://play.uxrzone.com/podcast.xml',
  'https://www.nznetradio.net.nz/podcast-feed-licensed.php',
  'https://dadaradio.net/category/electrojazz/feed/',
  'https://bacalao.ch/podcast2/technopolymere/Technopolyme_re.xml',
  'http://bacalao.ch/podcast2/bakalator/Bakalator.xml',
  'https://www.concertzender.nl/programma_genre/cinematheque__crosslinks-nl/feed/',
  'https://feed.justcast.com/shows/what-da-house-radio/audioposts.rss',
  'https://feeds.rssblue.com/phantom-power-music-hour',
  'https://feeds.rssblue.com/sidestream-music-podcast',
  'https://feed.homegrownhits.xyz/feed.xml',
  'https://enoughrecords.scene.org/enrshow_feed',
  'https://wfmu.org/podcast/AO.xml',
  'https://wfmu.org/podcast/SV.xml',
  'https://wfmu.org/podcast/CR.xml',
  'https://wfmu.org/podcast/HG.xml',
  'https://wfmu.org/podcast/SH.xml',
  'https://wfmu.org/podcast/PL.xml',
  'https://wfmu.org/podcast/AS.xml',
  'https://wfmu.org/podcast/AP.xml',
  'https://wfmu.org/podcast/LB.xml',
  'https://wfmu.org/podcast/DC.xml',
  'https://wfmu.org/podcast/GA.xml',
  'https://wfmu.org/podcast/FJ.xml',
  'https://wfmu.org/podcast/DQ.xml',
  'https://wfmu.org/podcast/NP.xml',
  'https://wfmu.org/podcast/DR.xml',
];

/** Every hand-checked music feed, in one list. */
export const MUSIC_FEEDS = [
  ...MUSIC_MEDIUM_ALBUMS,
  ...HOSTED_ALBUMS,
  ...FUNKWHALE_CHANNELS,
  ...NETLABELS,
  ...MIXES_AND_RADIO,
];

/**
 * Where music is not, and why looking again will not help.
 *
 * Written down because "why isn't Bandcamp in here" is the obvious question,
 * and the answer is a fact about those services rather than a gap in the list.
 * Each of these was checked directly rather than assumed.
 */
export const MUSIC_UNAVAILABLE = [
  {
    id: 'bandcamp',
    reason:
      'Bandcamp publishes no RSS for an artist, a label or an album — no autodiscovery tag and no conventional path. Only daily.bandcamp.com has a feed, and that is the magazine, not the music.',
  },
  {
    id: 'somafm',
    reason:
      'SomaFM streams under licences that do not permit download, so there are no enclosures to put in a feed. The archive feed its own site still links to has been a 404 for years.',
  },
  {
    id: 'free-music-archive',
    reason:
      'The Free Music Archive dropped its feeds in the rebuild. Nothing at /feed, /rss or /recent.atom answers, and the catalogue is only reachable through the site.',
  },
  {
    id: 'mixcloud-nts-jamendo',
    reason:
      'None of them publish RSS at all. Mixcloud and NTS are app-and-web only, and Jamendo moved to an API that needs a key.',
  },
  {
    id: 'faircamp',
    reason:
      'Faircamp\'s default /feed.rss carries no enclosures — it is a list of release pages. Only the opt-in /podcast.rss attaches audio, and almost no instance turns it on.',
  },
  {
    id: 'mirlo',
    reason:
      'Mirlo\'s artist feeds link to release pages without attaching the tracks, so a Mirlo feed is a blog about an artist rather than the artist\'s music.',
  },
];

/**
 * The list, as candidate URLs.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function musicCandidates(opts = {}) {
  const limit = opts.limit ?? MUSIC_FEEDS.length;
  return MUSIC_FEEDS.slice(0, Math.max(0, limit));
}
