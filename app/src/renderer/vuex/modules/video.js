import * as types from '../mutation-types'
import * as childProcess from 'child_process'
import path from 'path'
import * as fs from 'fs'
import { bus } from '../../shared/bus'
import moment from 'moment'

const mp4fragmentPath = require('../../assets/bin/mp4fragment.exe')
const mp4infoPath = require('../../assets/bin/mp4info.exe')
const ffmpegPath = require('../../assets/bin/ffmpeg.exe')

const state = {
  selectedFile: {},
  chunkSize: 64 * 1024,
  requestedFile: {},
  transcodingProgress: 0,
  isTranscodingVideo: false,
  isTranscodingAudio: false
}

const mutations = {
  [types.UPDATE_SELECTED_FILE] (state, payload) {
    state.selectedFile = payload
  },
  [types.UPDATE_REQUESTED_FILE] (state, payload) {
    state.requestedFile = payload
  },
  [types.UPDATE_TRANSCODING_PROGRESS] (state, payload) {
    state.transcodingProgress = payload
  },
  [types.UPDATE_IS_TRANSCODING_VIDEO] (state, payload) {
    state.isTranscodingVideo = payload
  },
  [types.UPDATE_IS_TRANSCODING_AUDIO] (state, payload) {
    state.isTranscodingAudio = payload
  },
  [types.RESET_VIDEO_STATE] (state) {
    state.transcodingProgress = 0
    state.isTranscodingVideo = false
    state.isTranscodingAudio = false
  }
}

let fragmentedFilesDirectory, binPath, destinationFile, destinationPath, timeout

const actions = {
  handleGetFileRequest: ({commit}, selectedFile) => {
    console.log('handleGetFileRequest', selectedFile)

    // Stop sending chunks
    if (readStream) readStream.pause()
    clearTimeout(timeout)

    // Reset the state
    commit(types.RESET_VIDEO_STATE)

    // Create a directory to store fragmented files if it doesn't exist already
    fragmentedFilesDirectory = path.join(selectedFile.path, '.netsix')
    if (!fs.existsSync(fragmentedFilesDirectory)) {
      fs.mkdirSync(fragmentedFilesDirectory)
    }

    // The final file must be a mp4
    destinationFile = selectedFile.filename.substr(0, selectedFile.filename.lastIndexOf('.')) + '.mp4'
    destinationPath = path.join(fragmentedFilesDirectory, destinationFile)

    // The folder where the mp4 tools' binaries are stored
    binPath = process.env.NODE_ENV === 'production' ? 'resources/app/dist' : 'app/dist'

    let fileExtension = selectedFile.filename.split('.').pop()
    if (fileExtension === 'mkv') {
      handleGetMkvRequest(commit, selectedFile)
    } else {
      // Check if a fragmented version of the selected already exists
      if (!fs.existsSync(destinationPath)) {
        // mp4fragment input.mp4 .netsix/output.mp4
        childProcess.execFile(path.join(binPath, mp4fragmentPath), [path.join(selectedFile.path, selectedFile.filename), destinationPath], (error, stdout, stderr) => {
          if (error) console.error(`error: ${error}`)
          if (stdout) console.log(`stdout: ${stdout}`)
          if (stderr) console.log(`stderr: ${stderr}`)

          if (error) {
            // Error, reset the state
            commit(types.UPDATE_REQUESTED_FILE, Object.assign({}, {}))
            commit(types.RESET_VIDEO_STATE)
            commit('PUSH_NOTIFICATION', {type: 'danger', message: 'An error occurred during the file fragmentation process.'})
          }

          // Success, get file information to instantiate the MediaSource object
          generateFileInformation(commit, selectedFile)
        })
      } else {
        // A fragmented version of the selected file already exists
        // No need to fragment again, just get the file information
        generateFileInformation(commit, selectedFile)
      }
    }
  },
  handleAckFileInformation: ({commit}, file) => {
    console.log('handleAckFileInformation', file)
    readAndSendFile(commit, file)
  },
  handleCancelTranscodingInformation: ({commit}) => {
    console.log('handleCancelTranscodingInformation')
    // Cancel the transcoding and reset the state
    ffmpegTranscode.kill()
    commit(types.UPDATE_REQUESTED_FILE, Object.assign({}, {}))
    commit(types.RESET_VIDEO_STATE)
  }
}

const generateFileInformation = function (commit, selectedFile) {
  let fileInfo = JSON.parse(childProcess.execFileSync(path.join(binPath, mp4infoPath), ['--format', 'json', destinationPath], {encoding: 'utf8'}))
  console.log('fileInfo', fileInfo)

  let size = fs.statSync(destinationPath).size
  let totalChunks = Math.ceil(size / state.chunkSize)

  let file = {
    ...selectedFile,
    path: fragmentedFilesDirectory,
    filename: destinationFile,
    size: size,
    totalChunks: totalChunks,
    information: fileInfo
  }

  commit(types.UPDATE_SELECTED_FILE, Object.assign({}, file))
  commit(types.UPDATE_REQUESTED_FILE, Object.assign({}, {}))

  // Send the file information to the other peer if it's a remote request
  if (selectedFile.type === 'remote') {
    checkBufferAndSendFileInformation(file)
  }
}

let readStream

const readAndSendFile = function (commit, file) {
  // Finally, read the file chunk by chunk, store the chunks and send them
  readStream = fs.createReadStream(path.join(file.path, file.filename), {highWaterMark: state.chunkSize})

  readStream.on('data', function (chunk) {
    console.log('readStream: data', chunk.byteLength)
    // Ideally, we should send the chunks to the other peer here
    if (file.type === 'remote') {
      let peer = window.clientPeer._pcReady ? window.clientPeer : window.hostPeer
      peer.send(chunk)
      if (peer._channel.bufferedAmount > 0) console.log('readStream: bufferedamount', peer._channel.bufferedAmount)
      if (peer._channel.bufferedAmount >= 8 * 1024 * 1024) {
        readStream.pause()
        timeout = setTimeout(() => {
          readStream.resume()
        }, 1000)
      }
    }

    // Emit a chunk if we are not connected locally (through a manuel connection for example) to track the upload progress
    if (!(window.clientPeer._pcReady && window.hostPeer._pcReady)) bus.$emit('video:chunk', chunk)
  }).on('end', function () {
    console.log('readStream: end')
  })
}

const checkBufferAndSendFileInformation = function (file) {
  let peer = window.clientPeer._pcReady ? window.clientPeer : window.hostPeer
  if (peer._channel.bufferedAmount > 0) {
    setTimeout(() => {
      checkBufferAndSendFileInformation(file)
    }, 1000)
  } else {
    peer.send(JSON.stringify({
      type: 'SEND_FILE_INFORMATION',
      payload: file
    }))
  }
}

let ffmpegTranscode, transcodedMkvDirectory

// Handle mkv requests
const handleGetMkvRequest = function (commit, selectedFile) {
  console.log('handleGetMkvRequest', selectedFile)
  // Check if a fragmented version of the selected already exists
  if (!fs.existsSync(destinationPath)) {
    // Create a directory to store transcoded mkv files if it doesn't exist already
    transcodedMkvDirectory = path.join(fragmentedFilesDirectory, 'mkv')
    if (!fs.existsSync(transcodedMkvDirectory)) {
      fs.mkdirSync(transcodedMkvDirectory)
    }

    // ffmpeg -i input.mkv -sn -vcodec copy -acodec copy .netsix/mkv/output.mp4
    let ffmpegMkvToMp4 = childProcess.execFile(path.join(binPath, ffmpegPath), ['-i', path.join(selectedFile.path, selectedFile.filename), '-sn', '-vcodec', 'copy', '-acodec', 'copy', path.join(transcodedMkvDirectory, destinationFile)], (error, stdout, stderr) => {
      if (error) console.error(`error: ${error}`)
      if (stdout) console.log(`stdout: ${stdout}`)
      if (stderr) console.log(`stderr: ${stderr}`)

      if (error) {
        // Error, reset the state
        commit(types.UPDATE_REQUESTED_FILE, Object.assign({}, {}))
        commit(types.RESET_VIDEO_STATE)
        commit('PUSH_NOTIFICATION', {type: 'danger', message: 'An error occurred during the file fragmentation process.'})
      }

      // Success, get file information to instantiate the MediaSource object
      let fileInfo = JSON.parse(childProcess.execFileSync(path.join(binPath, mp4infoPath), ['--format', 'json', path.join(transcodedMkvDirectory, destinationFile)], {encoding: 'utf8'}))
      console.log('fileInfo', fileInfo)

      let codecs = {}
      for (let track of fileInfo.tracks) {
        codecs[track.type.toLowerCase()] = track.sample_descriptions[0].codecs_string
      }

      let isVideoTypeSupported = MediaSource.isTypeSupported('video/mp4; codecs="' + codecs.video + '"')
      let isAudioTypeSupported = MediaSource.isTypeSupported('video/mp4; codecs="' + codecs.audio + '"')

      console.log('handleGetMkvRequest: codecs', codecs)
      console.log('handleGetMkvRequest: isVideoTypeSupported', isVideoTypeSupported)
      console.log('handleGetMkvRequest: isAudioTypeSupported', isAudioTypeSupported)

      let ffmpegArguments = []
      if (isVideoTypeSupported && isAudioTypeSupported) {
        // All tracks are immediately playable (could be fragmented immediately instead of going through ffmpeg again)
        ffmpegArguments = ['-c:v', 'copy', '-c:a', 'copy']
      } else if (isVideoTypeSupported && !isAudioTypeSupported) {
        ffmpegArguments = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k']
      } else if (!isVideoTypeSupported && isAudioTypeSupported) {
        ffmpegArguments = ['-c:v', 'libx264', '-preset', 'medium', '-b:v', '2600k', '-c:a', 'copy']
      } else {
        ffmpegArguments = ['-c:v', 'libx264', '-preset', 'medium', '-b:v', '2600k', '-c:a', 'aac', '-b:a', '128k']
      }

      if (selectedFile.type === 'remote') {
        let peer = window.clientPeer._pcReady ? window.clientPeer : window.hostPeer
        if (!(isVideoTypeSupported && isAudioTypeSupported)) {
          peer.send(JSON.stringify({
            type: 'NEED_TRANSCODING',
            payload: {
              isVideoTypeSupported: isVideoTypeSupported,
              isAudioTypeSupported: isAudioTypeSupported
            }
          }))
        }
        peer.send(JSON.stringify({type: 'TRANSCODING_PROGRESS', payload: 0}))
      }

      if (!(isVideoTypeSupported && isAudioTypeSupported)) {
        commit('PUSH_NOTIFICATION', {
          type: 'warning',
          message: `Transcoding needed! It may take a while.<br>Video: ${!isVideoTypeSupported}, audio: ${!isAudioTypeSupported}.`
        })
      }
      commit('PUSH_NOTIFICATION', {type: 'info', message: 'Begin to transcode ' + destinationFile + '. It may take a while.'})

      // ffmpeg -i .netsix/mkv/input.mp4 -c:v libx264 -preset medium -b:v 2600k -c:a aac -b:a 128k .netsix/mkv/t_output.mp4
      ffmpegTranscode = childProcess.execFile(path.join(binPath, ffmpegPath), ['-i', path.join(transcodedMkvDirectory, destinationFile), ...ffmpegArguments, path.join(transcodedMkvDirectory, 't_' + destinationFile)], (error, stdout, stderr) => {
        if (error) console.error(`error: ${error}`)
        if (stdout) console.log(`stdout: ${stdout}`)
        if (stderr) console.log(`stderr: ${stderr}`)

        if (!error) {
          commit(types.UPDATE_TRANSCODING_PROGRESS, 100)
          commit('PUSH_NOTIFICATION', {type: 'info', message: 'Done transcoding ' + destinationFile + '.'})
          if (selectedFile.type === 'remote') {
            let peer = window.clientPeer._pcReady ? window.clientPeer : window.hostPeer
            peer.send(JSON.stringify({type: 'TRANSCODING_PROGRESS', payload: 100}))
          }

          // Remove the non-transcoded file
          fs.unlinkSync(path.join(transcodedMkvDirectory, destinationFile))

          // Then, fragment the transcoded file
          // mp4fragment .netsix/mkv/t_input.mp4 .netsix/output.mp4
          childProcess.execFile(path.join(binPath, mp4fragmentPath), [path.join(transcodedMkvDirectory, 't_' + destinationFile), destinationPath], (error, stdout, stderr) => {
            if (error) console.error(`error: ${error}`)
            if (stdout) console.log(`stdout: ${stdout}`)
            if (stderr) console.log(`stderr: ${stderr}`)

            // Remove the non-fragmented file
            fs.unlinkSync(path.join(transcodedMkvDirectory, 't_' + destinationFile))

            if (error) {
              // Error, reset the state
              commit(types.UPDATE_REQUESTED_FILE, Object.assign({}, {}))
              commit(types.RESET_VIDEO_STATE)
              commit('PUSH_NOTIFICATION', {type: 'danger', message: 'An error occurred during the file fragmentation process.'})
            }

            // Success, get file information to instantiate the MediaSource object
            generateFileInformation(commit, selectedFile)
          })
        } else {
          // Remove temporary/uncomplete files
          fs.unlinkSync(path.join(transcodedMkvDirectory, destinationFile))
          fs.unlinkSync(path.join(transcodedMkvDirectory, 't_' + destinationFile))
        }
      })

      console.log('ffmpeg -i input.mkv', ffmpegArguments, 'output.mp4')

      ffmpegTranscode.stdout.on('data', function (data) {
        console.log(`stdout: ${data.toString()}`)
      })

      ffmpegTranscode.stderr.on('data', function (data) {
        console.log(`stderr: ${data.toString()}`)

        // Notifiy of the transcoding progress
        // Example of an ffmpeg progress line: frame=24628 fps=6805 q=-1.0 size=  436672kB time=00:17:07.06 bitrate=3482.9kbits/s speed= 284x
        let timeRegex = new RegExp(/frame.*time=(.*)\sbitrate.*/, 'i')
        if (data.search(timeRegex) > -1) {
          let transcodingTimeProgress = timeRegex.exec(data)[1]
          let transcodingTimeProgressInMilliseconds = moment.duration(transcodingTimeProgress)._milliseconds
          let transcodingTimeProgressInPercentage = (transcodingTimeProgressInMilliseconds * 100) / fileInfo.movie.duration
          commit(types.UPDATE_TRANSCODING_PROGRESS, parseInt(transcodingTimeProgressInPercentage))

          // Send the transcoding progress through WebRTC
          if (selectedFile.type === 'remote') {
            let peer = window.clientPeer._pcReady ? window.clientPeer : window.hostPeer
            peer.send(JSON.stringify({type: 'TRANSCODING_PROGRESS', payload: parseInt(transcodingTimeProgressInPercentage)}))
          }
        }
      })
    })

    ffmpegMkvToMp4.stdout.on('data', function (data) {
      console.log(`stdout: ${data.toString()}`)
    })
  } else {
    // A fragmented version of the selected file already exists
    // No need to fragment again, just get the file information
    generateFileInformation(commit, selectedFile)
  }
}

export default {
  state,
  mutations,
  actions
}
