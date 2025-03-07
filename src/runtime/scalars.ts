// locals
import type { ConfigFile } from './config'
import {
	MutationArtifact,
	QueryArtifact,
	SubscriptionArtifact,
	SubscriptionSelection,
} from './types'

export function marshalSelection({
	config,
	selection,
	data,
}: {
	config: ConfigFile
	selection: SubscriptionSelection
	data: unknown
}): {} | null | undefined {
	if (data === null || typeof data === 'undefined') {
		return data
	}

	// if we are looking at a list
	if (Array.isArray(data)) {
		// unmarshal every entry in the list
		return data.map((val) => marshalSelection({ config, selection, data: val }))
	}

	// we're looking at an object, build it up from the current input
	return Object.fromEntries(
		Object.entries(data as {}).map(([fieldName, value]) => {
			// look up the type for the field
			const { type, fields } = selection[fieldName]
			// if we don't have type information for this field, just use it directly
			// it's most likely a non-custom scalars or enums
			if (!type) {
				return [fieldName, value]
			}

			// if there is a sub selection, walk down the selection
			if (fields) {
				return [fieldName, marshalSelection({ config, selection: fields, data: value })]
			}

			// is the type something that requires marshaling
			if (config.scalars?.[type]) {
				const marshalFn = config.scalars[type].marshal
				if (!marshalFn) {
					throw new Error(
						`scalar type ${type} is missing a \`marshal\` function. see https://github.com/AlecAivazis/houdini#%EF%B8%8Fcustom-scalars`
					)
				}
				if (Array.isArray(value)) {
					return [fieldName, value.map(marshalFn)]
				}
				return [fieldName, marshalFn(value)]
			}

			// if the type doesn't require marshaling and isn't a referenced type
			// then the type is a scalar that doesn't require marshaling
			return [fieldName, value]
		})
	)
}

export function marshalInputs<T>({
	artifact,
	config,
	input,
	rootType = '@root',
}: {
	artifact: QueryArtifact | MutationArtifact | SubscriptionArtifact
	config: ConfigFile
	input: unknown
	rootType?: string
}): {} | null | undefined {
	if (input === null || typeof input === 'undefined') {
		return input
	}

	// if there are no inputs in the object, nothing to do
	if (!artifact.input) {
		return input as {}
	}

	// the object containing the relevant fields
	const fields = rootType === '@root' ? artifact.input.fields : artifact.input.types[rootType]

	// if we are looking at a list
	if (Array.isArray(input)) {
		return input.map((val) => marshalInputs({ artifact, config, input: val, rootType }))
	}

	// we're looking at an object, build it up from the current input
	return Object.fromEntries(
		Object.entries(input as {}).map(([fieldName, value]) => {
			// look up the type for the field
			const type = fields?.[fieldName]
			// if we don't have type information for this field, just use it directly
			// it's most likely a non-custom scalars or enums
			if (!type) {
				return [fieldName, value]
			}

			// is the type something that requires marshaling
			const marshalFn = config.scalars?.[type]?.marshal
			if (marshalFn) {
				// if we are looking at a list of scalars
				if (Array.isArray(value)) {
					return [fieldName, value.map(marshalFn)]
				}
				return [fieldName, marshalFn(value)]
			}

			// if the type doesn't require marshaling and isn't a referenced type
			if (isScalar(config, type) || !artifact.input!.types[type]) {
				return [fieldName, value]
			}

			// we ran into an object type that should be referenced by the artifact
			return [fieldName, marshalInputs({ artifact, config, input: value, rootType: type })]
		})
	)
}

export function unmarshalSelection(
	config: ConfigFile,
	selection: SubscriptionSelection,
	data: unknown
): {} | null | undefined {
	if (data === null || typeof data === 'undefined') {
		return data
	}

	// if we are looking at a list
	if (Array.isArray(data)) {
		// unmarshal every entry in the list
		return data.map((val) => unmarshalSelection(config, selection, val))
	}

	// we're looking at an object, build it up from the current input
	return Object.fromEntries(
		Object.entries(data as {}).map(([fieldName, value]) => {
			// look up the type for the field
			const { type, fields } = selection[fieldName]
			// if we don't have type information for this field, just use it directly
			// it's most likely a non-custom scalars or enums
			if (!type) {
				return [fieldName, value]
			}

			// if there is a sub selection, walk down the selection
			if (fields) {
				return [
					fieldName,
					// unmarshalSelection({ artifact, config, input: value, rootType: type }),
					unmarshalSelection(config, fields, value),
				]
			}

			// is the type something that requires marshaling
			if (config.scalars?.[type]?.marshal) {
				const unmarshalFn = config.scalars[type].unmarshal
				if (!unmarshalFn) {
					throw new Error(
						`scalar type ${type} is missing an \`unmarshal\` function. see https://github.com/AlecAivazis/houdini#%EF%B8%8Fcustom-scalars`
					)
				}
				if (Array.isArray(value)) {
					return [fieldName, value.map(unmarshalFn)]
				}
				return [fieldName, unmarshalFn(value)]
			}

			// if the type doesn't require marshaling and isn't a referenced type
			// then the type is a scalar that doesn't require marshaling
			return [fieldName, value]
		})
	)
}

// we can't use config.isScalar because that would require bundling in ~/common
export function isScalar(config: ConfigFile, type: string) {
	return ['String', 'Boolean', 'Float', 'ID', 'Int']
		.concat(Object.keys(config.scalars || {}))
		.includes(type)
}
