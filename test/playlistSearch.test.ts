import { describe, expect, it } from 'vitest'

import { filterPlaylistSongs } from '../src/services/playlistSearch'

const songs = [
  { name: 'SAKURA リグレット', artists: [{ name: 'Flower' }], album: { name: 'Sakura Regret' } },
  { name: 'GORILLA SHIBAI', artists: [{ name: 'Vaundy' }], album: { name: 'GORILLA SHIBAI' } },
  { name: 'How crazy (Album Version)', artists: [{ name: 'YUI' }, { name: 'Guest' }], album: { name: "Can't Buy My Love" } },
  { name: '体温', artists: [{ name: '水槽' }], album: { name: '夜天邂逅' } },
]

describe('playlist in-panel search', () => {
  it('returns the original list for an empty / blank query', () => {
    expect(filterPlaylistSongs(songs, '')).toHaveLength(songs.length)
    expect(filterPlaylistSongs(songs, '   ')).toHaveLength(songs.length)
  })

  it('matches by song name, case-insensitively', () => {
    expect(filterPlaylistSongs(songs, 'sakura').map(s => s.name)).toEqual(['SAKURA リグレット'])
    expect(filterPlaylistSongs(songs, 'GORILLA').map(s => s.name)).toEqual(['GORILLA SHIBAI'])
  })

  it('matches by artist, including non-leading artists', () => {
    expect(filterPlaylistSongs(songs, 'vaundy').map(s => s.name)).toEqual(['GORILLA SHIBAI'])
    // 第二歌手也要命中（合唱曲目只匹配第一位会漏）
    expect(filterPlaylistSongs(songs, 'guest').map(s => s.name)).toEqual(['How crazy (Album Version)'])
  })

  it('matches by album name', () => {
    expect(filterPlaylistSongs(songs, 'buy my love').map(s => s.name)).toEqual(['How crazy (Album Version)'])
    expect(filterPlaylistSongs(songs, '夜天').map(s => s.name)).toEqual(['体温'])
  })

  it('trims the query and returns an empty array when nothing matches', () => {
    expect(filterPlaylistSongs(songs, '  YUI  ').map(s => s.name)).toEqual(['How crazy (Album Version)'])
    expect(filterPlaylistSongs(songs, 'zzzz-not-here')).toEqual([])
  })

  it('survives songs with missing fields', () => {
    const sparse = [{ name: 'Only Name' }, { artists: [{ name: 'Only Artist' }] }, {}] as never[]
    expect(filterPlaylistSongs(sparse, 'only')).toHaveLength(2)
    expect(filterPlaylistSongs(sparse, 'name')).toHaveLength(1)
  })
})
