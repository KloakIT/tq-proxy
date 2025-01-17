/*!
 * Copyright 2017 QTGate systems Inc. All Rights Reserved.
 *
 * QTGate systems Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as crypto from 'crypto'
import * as Async from 'async'
import * as Stream from 'stream'
import * as Net from 'net'

const EOF = Buffer.from ( '\r\n\r\n')

export interface packetBuffer {
	command: number;
	uuid: string;
	buffer: Buffer;
	serial: number
}

export interface pairConnect {
	serverListen: string;
	clientListen: string;
}

export const encrypt = ( text: Buffer, masterkey: string, CallBack ) => {
	let salt = null
	Async.waterfall ([
		next => crypto.randomBytes ( 64, next ),
		( _salt, next ) => {
			salt = _salt
			crypto.pbkdf2 ( masterkey, salt, 2145, 32, 'sha512', next )
		}
	], ( err, derivedKey ) => {
		if ( err )
			return CallBack ( err )
		
		crypto.randomBytes ( 12, ( err1, iv ) => {
			if ( err1 )
				return CallBack ( err1 )
			
			const cipher = crypto.createCipheriv ( 'aes-256-gcm', derivedKey, iv );
		
			let _text = Buffer.concat ([ Buffer.alloc ( 4, 0 ) , text ])
			_text.writeUInt32BE ( text.length, 0 )
			if ( text.length < 500 ) {
				 _text = Buffer.concat ([ _text, Buffer.alloc ( 100 + Math.random () * 1000 )])
			}
			const encrypted = Buffer.concat ([ cipher.update ( _text ), cipher.final ()]);
			const ret = Buffer.concat ([ salt, iv, cipher.getAuthTag(), encrypted ])
			
			return CallBack ( null, ret )
		})
	})
}
/**
 * Decrypts text by given key
 * @param String base64 encoded input data
 * @param Buffer masterkey
 * @returns String decrypted (original) text
 */
export const decrypt =  ( data: Buffer, masterkey, CallBack ) => {
	if ( !data || !data.length )
		return CallBack ( new Error( 'null' ))
	try {
		// base64 decoding

		// convert data to buffers

		const salt = data.slice ( 0, 64 );
		const iv = data.slice ( 64, 76 );
		const tag = data.slice ( 76, 92 );
		const text = data.slice ( 92 );
		// derive key using; 32 byte key length
		crypto.pbkdf2 ( masterkey, salt , 2145, 32, 'sha512', ( err, derivedKey ) => {
			
			if ( err )
				return CallBack ( err )
			// AES 256 GCM Mode
			try {
				const decipher = crypto.createDecipheriv ( 'aes-256-gcm', derivedKey, iv )
				decipher.setAuthTag ( tag )
				const decrypted = Buffer.concat([decipher.update ( text ), decipher.final ( )]) 
				const leng = decrypted.slice( 4, 4 + decrypted.readUInt32BE(0))
				return CallBack ( null, leng )
			} catch ( ex ) {
				console.log ( `decrypt catch error [${ ex.message }]`)
			}
			

			
		})

	} catch ( e ) {
		return CallBack ( e )
	}

}

export const packetBuffer = ( bit0: number, _serial: number, id: string, buffer: Buffer ) => {
	
	const _buffer = Buffer.alloc ( 6, 0 )
	_buffer.writeUInt8 ( bit0, 0 )
	_buffer.writeUInt32BE ( _serial, 1 )

	const uuid = Buffer.from ( id )
	_buffer.writeUInt8 ( id.length, 5 )
	if ( buffer && buffer.length )
		return Buffer.concat ([ _buffer, uuid, buffer ])
	return Buffer.concat ([ _buffer, uuid ])
}

export const openPacket = ( buffer: Buffer ) => {
	const idLength = buffer.readUInt8 ( 5 )
	return  {
		command: buffer.readUInt8 ( 0 ),
		serial: buffer.readUInt32BE ( 1 ),
		uuid: buffer.toString ( 'utf8', 6, 6 + idLength ),
		buffer: buffer.slice ( 6 + idLength )
	}
}
const HTTP_HEADER = Buffer.from (
	`HTTP/1.1 200 OK\r\nDate: ${ new Date ().toUTCString ()}\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\nVary: Accept-Encoding\r\n\r\n`, 'utf8')
const HTTP_EOF = Buffer.from ( '\r\n\r\n', 'utf8' )

export class encryptStream extends Stream.Transform {
	private salt: Buffer
	private iv: Buffer
	private first = true
	public derivedKey: Buffer = null

	private BlockBuffer ( _buf: Buffer ) {
		return Buffer.from( _buf.length.toString( 16 ).toUpperCase() + '\r\n', 'utf8' )
	}
	private init ( callback ) {
		return Async.waterfall ([
			next => crypto.randomBytes ( 64, next ),
			( _salt, next ) => {
				this.salt = _salt
				crypto.randomBytes ( 12, next )
			},
			( _iv, next ) => {
				this.iv = _iv
				crypto.pbkdf2 ( this.password, this.salt, 2145, 32, 'sha512', next )
			}
		], ( err, derivedKey ) => {
			
			this.derivedKey = derivedKey
			return callback ( err )
		})
	}

	constructor ( private password: string, private random: number, private httpHeader : ( str: string ) => Buffer ) {
		super ()
	}
	
	public _transform ( chunk: Buffer, encode, cb ) {
		if ( !this.derivedKey) {
			return this.init (() => {
				return this._transform ( chunk, encode, cb )
			})
		}
		const cipher = crypto.createCipheriv ( 'aes-256-gcm', this.derivedKey, this.iv )

		let _text = Buffer.concat ([ Buffer.alloc ( 4, 0 ) , chunk ])

		_text.writeUInt32BE ( chunk.length, 0 )

		if ( chunk.length < this.random ) {
			_text = Buffer.concat ([ _text, Buffer.allocUnsafe ( Math.random() * 1000 )])
		}
		const _buf = Buffer.concat ([ cipher.update ( _text ), cipher.final ()])
		const _buf1 = Buffer.concat ([ cipher.getAuthTag (), _buf ])
		
		if ( this.first ) {
			this.first = false
			const black = Buffer.concat ([ this.salt, this.iv, _buf1 ]).toString ( 'base64' )
			if ( ! this.httpHeader ) {
				const _buf4 = Buffer.from ( black, 'base64')
				return cb ( null, Buffer.concat ([ HTTP_HEADER, this.BlockBuffer ( _buf4 ), _buf4, EOF ]))
			}
			const _buf2 = this.httpHeader ( black )

			return cb ( null, _buf2 )
		}
		
		const _buf2 = _buf1.toString( 'base64' )

		if ( this.httpHeader ) {
			return cb ( null, this.httpHeader ( _buf2 ))
		}
		const _buf3 = Buffer.from ( _buf2, 'base64' )
		return cb ( null, Buffer.concat ([ this.BlockBuffer ( _buf3 ), _buf3, EOF ]))
	}
}

export class decryptStream extends Stream.Transform {
	private salt: Buffer
	private iv: Buffer
	private bufferLength = 8196

	private derivedKey: Buffer = null
	private _decrypt ( _text: Buffer ) {
		
		const decipher = crypto.createDecipheriv ( 'aes-256-gcm', this.derivedKey, this.iv )
		decipher.setAuthTag ( _text.slice ( 0, 16 ))
		try {
			const _buf = Buffer.concat ([ decipher.update ( _text.slice ( 16 )), decipher.final () ])
			
			const leng = _buf.slice ( 4, 4 + _buf.readUInt32BE ( 0 ))
			if ( leng && leng.length ) {
				return leng
			}
			
			return Buffer.allocUnsafe ( 0 )
		} catch ( e ) {
			console.log ( 'class decryptStream _decrypt error:', e.message )
			return Buffer.allocUnsafe ( 0 )
		}
	}

	public _First (  chunk: Buffer, CallBack: ( err?: Error, text?: Buffer ) => void ) {
		this.salt = chunk.slice ( 0, 64 );
		this.iv = chunk.slice ( 64, 76 );
		return crypto.pbkdf2 ( this.password, this.salt , 2145, 32, 'sha512', ( err, derivedKey ) => {
			if ( err ) {
				console.log ( `decryptStream crypto.pbkdf2 ERROR: ${ err.message }` )
				return CallBack ( err )
			}
			this.derivedKey = derivedKey
			const text = this._decrypt ( chunk.slice ( 76 ))
			if ( ! text.length )
				return CallBack ( new Error ( 'lenth = 0' ))
			return CallBack ( null, text )
		})
	}

	constructor ( private password: string, _buf: Buffer = Buffer.allocUnsafe (0)) {
		super ()
	}

	
	public _transform ( chunk: Buffer, encode, cb ) {
		
		if ( !this.derivedKey ) {
			return this._First ( chunk, cb )
		}

		const text = this._decrypt ( chunk )
		if ( ! text.length )
			return cb ( new Error ( 'lenth = 0'))
		return cb ( null, text )
		
	}
}

class encode extends Stream.Transform {
	constructor () { super ()}
	private kk = null
	public _transform ( chunk: Buffer, encode, cb ) {
		let start = chunk.slice (0)
		while ( start.length ) {
			const point = start.indexOf ( 0x0a )
			if ( point < 0 ) {
				this.push ( start )
				break
			}
			const _buf = start.slice ( 0, point )
			this.push ( _buf )
			start = start.slice ( point + 1 )
		}
		return cb ()
	}

}

class encodeHex extends Stream.Transform {
	constructor () { super ()}
	public _transform ( chunk: Buffer, encode, cb ) {
		
		return cb ( null, chunk.toString ('utf8'))
	}
}

export class getDecryptClientStreamFromHttp extends Stream.Transform {

	private first = true
	private text = ''
	constructor () { super ()}

	public getBlock ( block: string ) {
		

		const uu = block.split ('\r\n')
		if ( uu.length !== 2 ) {
			return null
		}
		const length = parseInt ( uu[0], 16 )

		const text = uu [1]
		if ( length === text.length ) {
			
			return text
		}
		return null
	}

	public _transform ( chunk: Buffer, encode, cb ) {

		this.text += chunk.toString ( 'utf8' )

		const line = this.text.split ( '\r\n\r\n' )

		while ( this.first && line.length > 1 || !this.first && line.length ) {

			if ( this.first ) {
				this.first = false
				line.shift()
			}

			const _text = line.shift ()

			if ( ! _text.length )
				continue

			if ( /HTTP\/1\.1 404 Not Found/.test ( _text )) {
				return cb ( new Error ( '404' ))
			}

			const text = this.getBlock ( _text )
			if ( ! text ) {
				//			middle data can't get block
				if ( line.length ) {
					console.log ( 'getDecryptStreamFromHttp have ERROR:\n*****************************\n' )
					console.log ( text )
					return this.unpipe()
				}
				this.text = _text
				return cb ()
			}

			const _back = Buffer.from ( text, 'base64' )

			this.push ( _back )
		}
		this.text = ''
		return cb ()
	}
}

export class printStream extends Stream.Transform {

	constructor ( private headString: string ) { super ()}
	public _transform ( chunk: Buffer, encode, cb ) {
		console.log ( this.headString )
		console.log ( chunk.toString ('hex'))
		console.log ( this.headString )
		
		return cb ( null, chunk )
	}
}

export class blockBuffer16 extends Stream.Writable {
	constructor ( private socket: Net.Socket ) {
		super ()
		this.socket.pause ()
	}
	public _write ( chunk: Buffer, encoding, cb ) {
		if ( this.socket.writable ) {
			console.log ( 'blockBuffer16 socket.write :', chunk.length )
			this.socket.write ( chunk )
			this.socket.resume ()
			return cb ()
		}
		console.log ( 'blockBuffer16 socket.writable false')
		return cb ()
	}
}

export class getDecrypGatwayStreamFromHttp extends Stream.Transform {

	private text = ''
	private formatErr ( text: string ) {
		const log = 'getDecryptRequestStreamFromHttp format ERROR:\n*****************************\n' + text + '\r\n'
		console.log ( log )
		this.saveLog ( log )
	}
	constructor ( private saveLog: ( str: string ) => void ) { super ()}

	public _transform ( chunk: Buffer, encode, cb ) {

		this.text += chunk.toString ( 'utf8' )
		const block = this.text.split ( '\r\n\r\n' )

		while ( block.length ) {

			const blockText = block.shift ()

			if ( ! blockText.length )
				continue
			
			if ( /^GET /i.test ( blockText )) {

				const _line = blockText.split ( '\r\n' )[ 0 ]
				const _url = _line.split ( ' ' )
				if ( _url.length < 2 ) {
					if ( block.length ) {
						this.formatErr ( blockText )
						return this.unpipe ()
					}
					this.text = blockText
					return cb ()
				}
				this.push ( Buffer.from ( _url[1].slice ( 1 ), 'base64' ))
				continue
			}

			if ( /^POST /i.test ( blockText )) {

				if ( block.length > 0 ) {
					const header = blockText.split ( '\r\n' )

					const _length = header.findIndex ( n => {
						return /^Content-Length: /i.test ( n )
					})
					if ( _length === -1 ) {
						this.formatErr ( blockText )
						return this.unpipe ()
					}

					const lengthString = header [ _length ].split ( ' ' )
					if ( lengthString.length !== 2 ) {
						this.formatErr ( blockText )
						return this.unpipe ()
					}

					const length = parseInt ( lengthString[ 1 ])
					if ( ! length ) {
						this.formatErr ( blockText )
						return this.unpipe ()
					}

					const _text = block.shift ()
					if ( length !== _text.length ) {
						const log = `${ blockText }\r\n\r\n${ _text }`
						if ( block.length > 0 ) {
							this.formatErr ( log )
							return this.unpipe ()
						}
						this.text = log
						return cb ()
					}

					this.push ( Buffer.from ( _text, 'base64' ))
					continue
				}

				this.text = blockText
				return cb ()
			}

			if ( blockText.length ) {
				if ( block.length ) {
					this.formatErr ( blockText )
					return this.unpipe ()
					
				}
				this.text = blockText
				return cb ()
			}
		}

		this.text = ''
		return cb ()
	}
}



export class SencryptStream extends Stream.Transform {
	private salt: Buffer
	private iv: Buffer
	public ERR: Error = null
	private first = true
	public derivedKey: Buffer = null

	private BlockBuffer ( _buf: Buffer ) {
		return Buffer.from( _buf.length.toString( 16 ).toUpperCase() + '\r\n', 'utf8' )
	}

	constructor ( private password: string, private random: number, private httpHeader : ( str: string ) => Buffer, CallBack ) {
		super ()
		Async.waterfall ([
			next => crypto.randomBytes ( 64, next ),
			( _salt, next ) => {
				this.salt = _salt
				crypto.randomBytes ( 12, next )
			},
			( _iv, next ) => {
				this.iv = _iv
				crypto.pbkdf2 ( password, this.salt, 2145, 32, 'sha512', next )
			}
		], ( err, derivedKey ) => {
			if ( err ) 
				return this.ERR = err
			this.derivedKey = derivedKey
			return CallBack ( err )
		})
	}
	
	public _transform ( chunk: Buffer, encode, cb ) {

		const cipher = crypto.createCipheriv ( 'aes-256-gcm', this.derivedKey, this.iv )

		let _text = Buffer.concat ([ Buffer.alloc ( 4, 0 ) , chunk ])

		_text.writeUInt32BE ( chunk.length, 0 )

		if ( chunk.length < this.random ) {
			_text = Buffer.concat ([ _text, Buffer.allocUnsafe ( Math.random() * 1000 )])
		}

		const _buf = Buffer.concat ([ cipher.update ( _text ), cipher.final ()])
		const _buf1 = Buffer.concat ([ cipher.getAuthTag (), _buf ])

		if ( this.first ) {
			this.first = false
			const black = Buffer.concat ([ this.salt, this.iv, _buf1 ]).toString ( 'base64' )
			if ( ! this.httpHeader ) {
				const _buf4 = Buffer.from ( black, 'utf8')
				return cb ( null, Buffer.concat ([ HTTP_HEADER, this.BlockBuffer ( _buf4 ), _buf4, EOF ]))
			}
				
			return cb ( null, this.httpHeader ( black ))

		}
		
		const _buf2 = _buf1.toString ( 'base64' )
		if ( this.httpHeader ) {
			return cb ( null, this.httpHeader ( _buf2 ))
		}
		const _buf3 = Buffer.from ( _buf2, 'utf8' )
		return cb ( null, Buffer.concat ([ this.BlockBuffer ( _buf3 ), _buf3, EOF ]))
	}
}

export class SdecryptStream extends Stream.Transform {
	private first = true
	private salt: Buffer
	private iv: Buffer

	private derivedKey: Buffer
	private decipher: crypto.Decipher

	public firstProcess (  chunk: Buffer, CallBack: ( err?: Error, text?: Buffer ) => void ) {

		this.first = false
		this.salt = chunk.slice ( 0, 64 );
		this.iv = chunk.slice ( 64, 76 );
		return crypto.pbkdf2 ( this.password, this.salt , 2145, 32, 'sha512', ( err, derivedKey ) => {
			if ( err ) {
				console.log ( `decryptStream crypto.pbkdf2 ERROR: ${ err.message }` )
				return CallBack ( err )
			}
			this.derivedKey = derivedKey
			const _buf = chunk.slice ( 76 )
			this.decipher = crypto.createDecipheriv ( 'aes-256-gcm', this.derivedKey, this.iv )
			// @ts-ignore
			this.decipher.setAuthTag ( _buf.slice ( 0, 16 ))
			try {
			const _Buf = Buffer.concat ([ this.decipher.update ( _buf.slice ( 16 )) , this.decipher.final () ])
			const uuu = _Buf.slice ( 4 )

			return  CallBack ( null, uuu )
			} catch ( e ) {
				console.log ( 'class decryptStream firstProcess _decrypt error:', e.message )
				return CallBack ()
			}
		})
	}

	constructor ( private password: string ) {
		
		super ()
		console.log ( `create new decryptStream with password: [${ password }]`)
	}

	public _transform ( chunk: Buffer, encode, cb ) {
				
			if ( this.first ) {
				return this.firstProcess ( chunk, cb )
			}
			this.decipher = crypto.createDecipheriv ( 'aes-256-gcm', this.derivedKey, this.iv )
			// @ts-ignore
			this.decipher.setAuthTag ( chunk.slice ( 0, 16 ))
			try {
				const _Buf = Buffer.concat ([ this.decipher.update ( chunk.slice ( 16 )) , this.decipher.final () ])
				return cb ( null, _Buf.slice( 4 ))
			} catch ( e ) {
				console.log ( 'class decryptStream _decrypt error:', e.message )
				return cb ()
			}
		
	}
}